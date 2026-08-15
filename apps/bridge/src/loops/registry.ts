import { eq } from 'drizzle-orm';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ids, slugify, validateLoop, type LoopDefinition } from '@helm/core';
import type { Runtime } from '../runtime.js';
import { loops } from '../db/schema.js';
import { ensureHelmDirs, paths } from '../paths.js';
import { STARTER_LOOPS } from './starters.js';

export interface LoopRow {
  id: string;
  name: string;
  filePath: string | null;
  definition: LoopDefinition;
  status: 'enabled' | 'parked' | 'disabled';
  iterationsToday: number;
  spendTodayUsd: number;
  lastOutcome: string | null;
  lastRunAt: number | null;
  parkedReason: string | null;
}

export interface RegisterFailure {
  file: string;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Loops live as YAML on disk and as rows in the database. The file is the
 * source of truth for the definition; the row carries the counters that must
 * survive a restart.
 */
export class LoopRegistry {
  constructor(private readonly rt: Runtime) {}

  /** Write the starter library once, on a fresh install. Never overwrites. */
  seedStarters(): number {
    ensureHelmDirs();
    let written = 0;
    for (const s of STARTER_LOOPS) {
      const file = join(paths.loops, s.file);
      if (existsSync(file)) continue;
      writeFileSync(file, s.yaml, 'utf8');
      written++;
    }
    return written;
  }

  /** Parse and register every YAML in ~/.helm/loops. Refuses invalid ones. */
  loadAll(): { registered: LoopRow[]; failures: RegisterFailure[] } {
    ensureHelmDirs();
    const registered: LoopRow[] = [];
    const failures: RegisterFailure[] = [];

    const files = readdirSync(paths.loops).filter((f) => /\.ya?ml$/i.test(f));
    for (const f of files) {
      const file = join(paths.loops, f);
      const res = this.registerFile(file);
      if (res.ok) registered.push(res.loop);
      else failures.push({ file: f, errors: res.errors });
    }

    // A loop whose file disappeared is archived, not silently forgotten.
    const known = new Set(registered.map((l) => l.name));
    for (const row of this.rt.db.select().from(loops).all()) {
      if (row.archivedAt || known.has(row.name)) continue;
      this.rt.db
        .update(loops)
        .set({ archivedAt: Date.now(), status: 'disabled' })
        .where(eq(loops.id, row.id))
        .run();
    }

    if (failures.length) {
      for (const f of failures) {
        this.rt.event({
          level: 'error',
          message: `loop ${f.file} refused: ${f.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
        });
      }
    }
    return { registered, failures };
  }

  registerFile(
    file: string,
  ): { ok: true; loop: LoopRow } | { ok: false; errors: Array<{ path: string; message: string }> } {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(file, 'utf8'));
    } catch (err) {
      return { ok: false, errors: [{ path: '(yaml)', message: (err as Error).message }] };
    }
    const res = validateLoop(raw);
    if (!res.ok) return { ok: false, errors: res.errors };
    return { ok: true, loop: this.upsert(res.loop, file) };
  }

  /** Register a definition, preserving counters and operator status. */
  upsert(def: LoopDefinition, file: string | null): LoopRow {
    const existing = this.rt.db.select().from(loops).where(eq(loops.name, def.name)).get();
    const values = {
      name: def.name,
      filePath: file,
      definitionJson: JSON.stringify(def),
      triggerType: def.trigger.type,
      budgetPerRunUsd: def.bounds.budget_per_run_usd,
      budgetPerDayUsd: def.bounds.budget_per_day_usd,
      maxIterationsPerDay: def.bounds.max_iterations_per_day,
      archivedAt: null,
    };

    if (existing) {
      this.rt.db.update(loops).set(values).where(eq(loops.id, existing.id)).run();
    } else {
      this.rt.db
        .insert(loops)
        .values({
          ...values,
          id: ids.loop(),
          // Law 8's spirit: a newly discovered loop never starts itself.
          status: def.enabled ? 'enabled' : 'disabled',
          iterationsToday: 0,
          spendTodayUsd: 0,
          createdAt: Date.now(),
        })
        .run();
    }
    return this.get(def.name)!;
  }

  list(): LoopRow[] {
    return this.rt.db
      .select()
      .from(loops)
      .all()
      .filter((r) => !r.archivedAt)
      .map(toRow);
  }

  get(nameOrId: string): LoopRow | null {
    const row =
      this.rt.db.select().from(loops).where(eq(loops.name, nameOrId)).get() ??
      this.rt.db.select().from(loops).where(eq(loops.id, nameOrId)).get();
    return row ? toRow(row) : null;
  }

  /**
   * Enabling is the moment a loop becomes real, so it is the moment every
   * agent reference must resolve. A loop pointing at an agent that does not
   * exist would fail silently at 3am otherwise.
   */
  setStatus(
    id: string,
    status: 'enabled' | 'parked' | 'disabled',
    reason?: string,
  ): { ok: true; loop: LoopRow } | { ok: false; error: string } {
    const loop = this.get(id);
    if (!loop) return { ok: false, error: 'no such loop' };

    if (status === 'enabled') {
      const missing = this.missingAgents(loop.definition);
      if (missing.length) {
        return {
          ok: false,
          error: `cannot enable: no agent named ${missing.join(', ')} — edit the loop or recruit them first`,
        };
      }
    }

    this.rt.db
      .update(loops)
      .set({ status, parkedReason: status === 'parked' ? (reason ?? 'parked') : null })
      .where(eq(loops.id, loop.id))
      .run();

    this.rt.event({
      level: status === 'parked' ? 'warn' : 'info',
      message: `loop ${loop.name} ${status}${reason ? ` — ${reason}` : ''}`,
    });
    const updated = this.get(loop.id)!;
    this.broadcast(updated);
    return { ok: true, loop: updated };
  }

  missingAgents(def: LoopDefinition): string[] {
    const cfg = this.rt.config.get();
    const known = new Set<string>();
    for (const a of cfg.agents) {
      known.add(a.id);
      known.add(a.name.toLowerCase());
    }
    const missing = new Set<string>();
    for (const s of def.steps) {
      if (!known.has(s.agent) && !known.has(s.agent.toLowerCase())) missing.add(s.agent);
    }
    return [...missing];
  }

  resolveAgentId(name: string): string | null {
    const cfg = this.rt.config.get();
    const hit =
      cfg.agents.find((a) => a.id === name) ??
      cfg.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
    return hit?.id ?? null;
  }

  readSource(id: string): string | null {
    const loop = this.get(id);
    if (!loop?.filePath || !existsSync(loop.filePath)) return null;
    return readFileSync(loop.filePath, 'utf8');
  }

  /** Save edited YAML, but only if it still satisfies Law 8. */
  writeSource(
    id: string,
    yaml: string,
  ): { ok: true; loop: LoopRow } | { ok: false; errors: Array<{ path: string; message: string }> } {
    const loop = this.get(id);
    if (!loop) return { ok: false, errors: [{ path: '(loop)', message: 'no such loop' }] };

    let raw: unknown;
    try {
      raw = parseYaml(yaml);
    } catch (err) {
      return { ok: false, errors: [{ path: '(yaml)', message: (err as Error).message }] };
    }
    const res = validateLoop(raw);
    if (!res.ok) return { ok: false, errors: res.errors };

    const file = loop.filePath ?? join(paths.loops, `${res.loop.name}.yaml`);
    writeFileSync(file, yaml, 'utf8');
    if (loop.filePath && loop.name !== res.loop.name && existsSync(loop.filePath)) {
      unlinkSync(loop.filePath);
    }
    return { ok: true, loop: this.upsert(res.loop, file) };
  }

  /**
   * The retro loop is per-agent: each one reads its own history and proposes
   * edits to its own playbook. Enabling it from the Mission view materialises a
   * dedicated `retro-<agent>` loop rather than sharing one across the fleet.
   */
  retroLoopName(agentName: string): string {
    return `retro-${slugify(agentName)}`;
  }

  enableRetroFor(
    agentId: string,
  ): { ok: true; loop: LoopRow } | { ok: false; error: string } {
    const agent = this.rt.config.get().agents.find((a) => a.id === agentId);
    if (!agent) return { ok: false, error: 'no such agent' };

    const template = this.get('retro');
    if (!template) return { ok: false, error: 'the retro starter loop is missing from ~/.helm/loops' };

    const name = this.retroLoopName(agent.name);
    const def: LoopDefinition = {
      ...template.definition,
      name,
      description: `Weekly playbook retro for ${agent.name} — proposes HELM.md edits behind the gate.`,
      steps: template.definition.steps.map((s) => ({ ...s, agent: agent.name })),
      enabled: true,
    };

    const file = join(paths.loops, `${name}.yaml`);
    writeFileSync(file, stringifyYaml(def), 'utf8');
    const row = this.upsert(def, file);
    const res = this.setStatus(row.id, 'enabled');
    if (!res.ok) return res;

    this.rt.event({
      agentId,
      message: `weekly retro enabled for ${agent.name} — playbook edits still go through the gate`,
    });
    return { ok: true, loop: res.loop };
  }

  disableRetroFor(agentId: string): boolean {
    const agent = this.rt.config.get().agents.find((a) => a.id === agentId);
    if (!agent) return false;
    const loop = this.get(this.retroLoopName(agent.name));
    if (!loop) return false;
    this.setStatus(loop.id, 'disabled');
    return true;
  }

  broadcast(loop: LoopRow, detail?: string): void {
    this.rt.send({
      type: 'loop.state',
      loopId: loop.id,
      status: loop.status,
      iterationsToday: loop.iterationsToday,
      spendTodayUsd: loop.spendTodayUsd,
      lastOutcome: loop.lastOutcome,
      detail,
      at: Date.now(),
    });
  }
}

function toRow(r: typeof loops.$inferSelect): LoopRow {
  return {
    id: r.id,
    name: r.name,
    filePath: r.filePath,
    definition: JSON.parse(r.definitionJson) as LoopDefinition,
    status: r.status as LoopRow['status'],
    iterationsToday: r.iterationsToday,
    spendTodayUsd: r.spendTodayUsd,
    lastOutcome: r.lastOutcome,
    lastRunAt: r.lastRunAt,
    parkedReason: r.parkedReason,
  };
}
