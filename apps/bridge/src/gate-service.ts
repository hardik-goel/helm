import { and, eq, lt } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ids, isInsideWorkspace, type GateItem, type GateKind } from '@helm/core';
import type { Runtime } from './runtime.js';
import { gateItems } from './db/schema.js';
import { rowToGateItem } from './repo.js';

const execFileAsync = promisify(execFile);

export interface CreateGateInput {
  agentId: string;
  sessionId?: string | null;
  loopRunId?: string | null;
  kind: GateKind;
  label: string;
  detail?: string;
  payload?: unknown;
  source?: 'permission-callback' | 'proposed-actions' | 'loop-step';
}

export type GateDecision = 'approved' | 'denied';

/**
 * The spine. Every irreversible action in Helm passes through a row in this
 * table, and the only thing that can turn a row green is a human.
 */
export class GateService extends EventEmitter {
  /** Sessions blocked mid-flight, keyed by gate item id. */
  private readonly waiters = new Map<string, (d: GateDecision) => void>();

  constructor(private readonly rt: Runtime) {
    super();
  }

  /**
   * Expire items whose waiter died with the last bridge process.
   *
   * Only permission-callback items are orphaned by a restart: they block a live
   * session that no longer exists. Proposed-actions items are executed by the
   * bridge itself and loop steps resume, so both survive and stay pending.
   */
  reapOrphansOnBoot(): void {
    const stale = this.rt.db
      .select()
      .from(gateItems)
      .where(eq(gateItems.status, 'pending'))
      .all()
      .filter((r) => r.source === 'permission-callback' && r.loopRunId === null);

    for (const row of stale) {
      this.rt.db
        .update(gateItems)
        .set({ status: 'expired', decidedAt: Date.now() })
        .where(eq(gateItems.id, row.id))
        .run();
    }
    if (stale.length) {
      this.rt.event({
        level: 'warn',
        message: `${stale.length} gate item(s) expired — their sessions did not survive the restart`,
      });
    }
  }

  expireStale(ttlMinutes: number): void {
    const cutoff = Date.now() - ttlMinutes * 60_000;
    const rows = this.rt.db
      .select()
      .from(gateItems)
      .where(and(eq(gateItems.status, 'pending'), lt(gateItems.createdAt, cutoff)))
      .all();
    for (const row of rows) {
      this.rt.db
        .update(gateItems)
        .set({ status: 'expired', decidedAt: Date.now() })
        .where(eq(gateItems.id, row.id))
        .run();
      this.waiters.get(row.id)?.('denied');
      this.waiters.delete(row.id);
      this.rt.send({ type: 'gate.decided', item: rowToGateItem({ ...row, status: 'expired' }) });
    }
  }

  create(input: CreateGateInput): GateItem {
    const row = {
      id: ids.gateItem(),
      agentId: input.agentId,
      sessionId: input.sessionId ?? null,
      loopRunId: input.loopRunId ?? null,
      kind: input.kind,
      label: input.label,
      detail: input.detail ?? '',
      payloadJson: input.payload === undefined ? null : JSON.stringify(input.payload),
      status: 'pending' as const,
      decidedBy: null,
      decision: null,
      decidedAt: null,
      executedAt: null,
      executionResult: null,
      source: input.source ?? 'permission-callback',
      createdAt: Date.now(),
    };
    this.rt.db.insert(gateItems).values(row).run();
    const item = rowToGateItem(row);
    this.rt.send({ type: 'gate.new', item });
    this.rt.event({
      agentId: input.agentId,
      level: 'warn',
      message: `gate: ${input.kind} — ${input.label}`,
    });
    return item;
  }

  /** Create the item and block until a human decides. Used by canUseTool. */
  async createAndWait(input: CreateGateInput): Promise<{ item: GateItem; decision: GateDecision }> {
    const item = this.create(input);
    const decision = await new Promise<GateDecision>((resolve) => {
      this.waiters.set(item.id, resolve);
    });
    return { item, decision };
  }

  /**
   * Law 1's only door. `decidedBy` is hard-coded to 'human' because this method
   * is only reachable from an HTTP route the operator drives; nothing inside
   * the bridge calls it, and no agent can reach it.
   */
  decide(id: string, decision: GateDecision): GateItem | null {
    const row = this.rt.db.select().from(gateItems).where(eq(gateItems.id, id)).get();
    if (!row || row.status !== 'pending') return null;

    const now = Date.now();
    this.rt.db
      .update(gateItems)
      .set({
        status: decision,
        decision,
        decidedBy: 'human',
        decidedAt: now,
      })
      .where(eq(gateItems.id, id))
      .run();

    const updated = this.rt.db.select().from(gateItems).where(eq(gateItems.id, id)).get()!;
    const item = rowToGateItem(updated);

    this.rt.send({ type: 'gate.decided', item });
    this.rt.event({
      agentId: row.agentId,
      level: decision === 'approved' ? 'info' : 'warn',
      message: `gate ${decision} by human: ${row.label}`,
    });

    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(decision);
    }
    // Loops parked on this item resume from here; loop triggers fire from here.
    this.emit('decided', item);
    return item;
  }

  /**
   * A session that ends can no longer act on an approval, so anything it left
   * pending is closed out and its held promise released. Without this, killing
   * an agent mid-decision leaks a waiter and strands the item forever.
   */
  expireForSession(sessionId: string): number {
    const rows = this.rt.db
      .select()
      .from(gateItems)
      .where(and(eq(gateItems.sessionId, sessionId), eq(gateItems.status, 'pending')))
      .all()
      .filter((r) => r.source === 'permission-callback');

    for (const row of rows) {
      this.rt.db
        .update(gateItems)
        .set({ status: 'expired', decidedAt: Date.now() })
        .where(eq(gateItems.id, row.id))
        .run();
      this.waiters.get(row.id)?.('denied');
      this.waiters.delete(row.id);
      this.rt.send({ type: 'gate.decided', item: rowToGateItem({ ...row, status: 'expired' }) });
    }
    return rows.length;
  }

  listPending(): GateItem[] {
    return this.rt.db
      .select()
      .from(gateItems)
      .where(eq(gateItems.status, 'pending'))
      .all()
      .map(rowToGateItem);
  }

  list(limit = 100): GateItem[] {
    return this.rt.db
      .select()
      .from(gateItems)
      .orderBy(gateItems.createdAt)
      .all()
      .slice(-limit)
      .reverse()
      .map(rowToGateItem);
  }

  get(id: string): GateItem | null {
    const row = this.rt.db.select().from(gateItems).where(eq(gateItems.id, id)).get();
    return row ? rowToGateItem(row) : null;
  }

  /** True only when the DB says a human approved this exact item. */
  isHumanApproved(id: string): boolean {
    const row = this.rt.db.select().from(gateItems).where(eq(gateItems.id, id)).get();
    return !!row && row.status === 'approved' && row.decision === 'approved' && row.decidedBy === 'human';
  }

  /**
   * Execute an approved payload. This is the ONLY function in Helm that runs a
   * gated command, and it re-reads the row from the database before doing so.
   * An in-memory "approved" flag is not evidence; the row is.
   */
  async execute(id: string, cwd: string): Promise<{ ok: boolean; output: string }> {
    const row = this.rt.db.select().from(gateItems).where(eq(gateItems.id, id)).get();
    if (!row) return { ok: false, output: 'no such gate item' };

    if (!(row.status === 'approved' && row.decision === 'approved' && row.decidedBy === 'human')) {
      const msg = `REFUSED: gate item ${id} is not human-approved (status=${row.status}, decided_by=${row.decidedBy})`;
      this.rt.event({ agentId: row.agentId, level: 'critical', message: msg });
      return { ok: false, output: msg };
    }
    if (row.executedAt) {
      return { ok: false, output: 'already executed — approval is single-use' };
    }

    const payload = row.payloadJson ? (JSON.parse(row.payloadJson) as Record<string, unknown>) : null;
    const command = typeof payload?.command === 'string' ? payload.command : null;

    if (!command) {
      // A permission-callback item has a live session waiting: approving it
      // releases the held promise and the agent performs the action itself.
      if (row.source === 'permission-callback') {
        return { ok: true, output: 'released to the waiting session' };
      }
      const applied = this.applyFilePayload(payload, cwd);
      if (applied) {
        this.markExecuted(id, applied.output);
        if (!applied.ok) {
          this.rt.event({
            agentId: row.agentId,
            level: 'error',
            message: `approved write failed: ${applied.output.slice(0, 300)}`,
          });
        }
        return applied;
      }
      // Nothing runnable and nobody waiting: say so loudly rather than
      // letting an approval look like a completed action.
      const msg = 'approved, but the proposal carried nothing the bridge can execute';
      this.markExecuted(id, msg);
      this.rt.event({ agentId: row.agentId, level: 'warn', message: `${msg}: ${row.label}` });
      return { ok: false, output: msg };
    }

    const workdir = typeof payload?.cwd === 'string' && payload.cwd !== '.' ? payload.cwd : cwd;
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: workdir,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const output = `${stdout}${stderr}`.trim();
      this.markExecuted(id, output.slice(0, 8000));
      this.rt.event({
        agentId: row.agentId,
        message: `executed approved ${row.kind}: ${command}`,
      });
      return { ok: true, output };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.trim();
      this.markExecuted(id, `FAILED: ${output.slice(0, 8000)}`);
      this.rt.event({
        agentId: row.agentId,
        level: 'error',
        message: `approved ${row.kind} failed: ${output.slice(0, 300)}`,
      });
      return { ok: false, output };
    }
  }

  /**
   * Apply a structured file proposal: either a whole-file `content`, or an
   * `old` → `new` replacement that must match exactly once. Refuses anything
   * resolving outside the project workspace.
   */
  private applyFilePayload(
    payload: Record<string, unknown> | null,
    cwd: string,
  ): { ok: boolean; output: string } | null {
    const file = typeof payload?.file === 'string' ? payload.file : null;
    if (!payload || !file) return null;

    const content = typeof payload.content === 'string' ? payload.content : null;
    const oldStr = typeof payload.old === 'string' ? payload.old : null;
    const newStr = typeof payload.new === 'string' ? payload.new : null;
    if (content === null && (oldStr === null || newStr === null)) return null;

    const target = resolve(cwd, file);
    if (!isInsideWorkspace(target, cwd)) {
      return { ok: false, output: `REFUSED: ${target} is outside the workspace` };
    }

    try {
      if (content !== null) {
        writeFileSync(target, content, 'utf8');
        return { ok: true, output: `wrote ${file} (${content.length} bytes)` };
      }
      if (!existsSync(target)) return { ok: false, output: `no such file: ${file}` };
      const current = readFileSync(target, 'utf8');
      const hits = current.split(oldStr!).length - 1;
      if (hits === 0) return { ok: false, output: `text to replace was not found in ${file}` };
      if (hits > 1) {
        return { ok: false, output: `text to replace appears ${hits} times in ${file} — ambiguous` };
      }
      writeFileSync(target, current.replace(oldStr!, newStr!), 'utf8');
      return { ok: true, output: `edited ${file}` };
    } catch (err) {
      return { ok: false, output: `write failed: ${(err as Error).message}` };
    }
  }

  private markExecuted(id: string, result: string): void {
    this.rt.db
      .update(gateItems)
      .set({ executedAt: Date.now(), executionResult: result })
      .where(eq(gateItems.id, id))
      .run();
  }
}
