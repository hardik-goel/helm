import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import {
  ids,
  parseProposedActions,
  type AgentStatus,
  type SessionExitReason,
} from '@helm/core';
import type { Runtime } from './runtime.js';
import type { GateService } from './gate-service.js';
import { agents, pulses, sessions } from './db/schema.js';
import {
  addSpend,
  agentSpendToday,
  fleetSpendToday,
  getAgent,
  getProject,
  rowToSession,
} from './repo.js';
import { TranscriptWriter } from './transcripts.js';
import { createRunner, AuthRequiredError, type AgentRunner, type RunSpec } from './runner/index.js';
import { readKeychainKey } from './runner/env.js';
import { denialNote, missionPrompt, pulsePrompt, readPulseReport } from './prompts.js';
import { syncProtocol } from './protocol.js';
import type { FleetControl } from './routes/fleet.js';

export type RunTrigger = 'manual' | 'heartbeat' | 'loop' | 'launch';

export interface RunRequest {
  agentId: string;
  trigger: RunTrigger;
  /** Overrides the default mission/pulse prompt. */
  prompt?: string;
  /** Extra operator instruction appended to the mission prompt. */
  instruction?: string;
  loopRunId?: string | null;
  resume?: boolean;
  maxTurns?: number;
  /** Per-loop billing override (Phase 8). Subscription unless asked otherwise. */
  billing?: 'subscription' | 'api';
}

export interface RunOutcome {
  sessionId: string;
  exitReason: SessionExitReason;
  costUsd: number;
  turns: number;
  finalText: string;
  gateItemIds: string[];
}

interface LiveSession {
  sessionId: string;
  agentId: string;
  abort: AbortController;
  startedAt: number;
  turns: number;
  transcript: TranscriptWriter;
  /** Guards against a kill and a natural exit both closing the same session. */
  finalized: boolean;
}

interface QueueEntry {
  req: RunRequest;
  priority: number;
  enqueuedAt: number;
  resolve: (o: RunOutcome) => void;
  reject: (e: Error) => void;
}

/**
 * Owns every child process. Nothing else in Helm may spawn one.
 *
 * Three laws meet here: the governor caps concurrency (5), the spend ceiling
 * parks agents at cap (4), and the kill switch tears everything down (3).
 */
export class Supervisor implements FleetControl {
  private readonly live = new Map<string, LiveSession>();
  private readonly queue: QueueEntry[] = [];
  private readonly runner: AgentRunner;
  private fleetCapAnnouncedFor: string | null = null;

  constructor(
    private readonly rt: Runtime,
    private readonly gate: GateService,
    runner?: AgentRunner,
  ) {
    this.runner = runner ?? createRunner();
  }

  get runnerKind(): 'sdk' | 'cli' {
    return this.runner.kind;
  }

  running(): number {
    return this.live.size;
  }

  queued(): string[] {
    return this.queue.map((q) => q.req.agentId);
  }

  liveSessionIds(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Law 3. SIGTERM every child, park every agent, and leave a persisted flag so
   * a restarted bridge comes back killed rather than eagerly resuming.
   */
  async killAll(reason: string, opts?: { pauseAgents?: boolean }): Promise<void> {
    const pauseAgents = opts?.pauseAgents ?? true;
    for (const entry of this.queue.splice(0)) {
      entry.reject(new Error(`killed before start: ${reason}`));
    }
    const victims = [...this.live.values()];
    for (const s of victims) s.abort.abort();

    const deadline = Date.now() + 1800;
    while (this.live.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // Anything still holding on is force-closed in the books; the process was
    // already signalled and cannot write past this point.
    for (const s of this.live.values()) {
      this.finalizeSession(s, { exitReason: 'killed', costUsd: 0, turns: s.turns });
      this.live.delete(s.sessionId);
    }

    // An operator kill parks the fleet; a graceful bridge shutdown must not,
    // or every restart would come back with every agent mysteriously paused.
    if (!pauseAgents) return;
    for (const a of this.rt.db.select().from(agents).all()) {
      if (a.archivedAt) continue;
      this.setAgentStatus(a.id, 'paused');
    }
  }

  async resumeAll(): Promise<void> {
    for (const a of this.rt.db.select().from(agents).all()) {
      if (a.archivedAt) continue;
      if (a.status === 'paused') this.setAgentStatus(a.id, 'idle');
    }
    this.pump();
  }

  /** Enqueue a run. Resolves when the session finishes, not when it starts. */
  request(req: RunRequest): Promise<RunOutcome> {
    if (this.rt.isKilled()) {
      return Promise.reject(new Error('fleet is killed — resume before running agents'));
    }
    const agent = getAgent(this.rt.db, req.agentId);
    if (!agent || agent.archivedAt) {
      return Promise.reject(new Error('no such agent'));
    }
    if (this.isAgentBusy(req.agentId)) {
      return Promise.reject(new Error(`${agent.name} already has a live session`));
    }

    const capCheck = this.checkSpend(agent.id, agent.dailyCapUsd);
    if (!capCheck.ok) return Promise.reject(new Error(capCheck.reason));

    return new Promise<RunOutcome>((resolve, reject) => {
      this.queue.push({
        req,
        priority: this.priorityOf(agent.projectId),
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      this.setAgentStatus(req.agentId, 'queued');
      this.pump();
    });
  }

  /** Project tree order is wake priority. Lower sorts first. */
  private priorityOf(projectId: string): number {
    return getProject(this.rt.db, projectId)?.sortOrder ?? 999;
  }

  private isAgentBusy(agentId: string): boolean {
    for (const s of this.live.values()) if (s.agentId === agentId) return true;
    return this.queue.some((q) => q.req.agentId === agentId);
  }

  private pump(): void {
    if (this.rt.isKilled()) return;
    const max = this.rt.config.get().governor.maxConcurrent;

    while (this.live.size < max && this.queue.length > 0) {
      this.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
      const entry = this.queue.shift()!;
      void this.start(entry);
    }
    this.rt.broadcastFleet({ running: this.live.size, queued: this.queued() });
  }

  private checkSpend(agentId: string, dailyCapUsd: number): { ok: true } | { ok: false; reason: string } {
    const gov = this.rt.config.get().governor;
    const fleet = fleetSpendToday(this.rt.db);
    if (fleet >= gov.fleetDailyCapUsd) {
      const today = new Date().toDateString();
      if (this.fleetCapAnnouncedFor !== today) {
        this.fleetCapAnnouncedFor = today;
        this.rt.event({
          level: 'critical',
          message: `FLEET SPEND CAP reached — $${fleet.toFixed(2)} of $${gov.fleetDailyCapUsd.toFixed(2)}. No agent will wake until tomorrow.`,
        });
      }
      return { ok: false, reason: 'fleet daily spend cap reached' };
    }

    const spent = agentSpendToday(this.rt.db, agentId);
    if (spent >= dailyCapUsd) {
      this.setAgentStatus(agentId, 'parked-cap');
      this.rt.event({
        agentId,
        level: 'warn',
        message: `parked at daily cap — $${spent.toFixed(2)} of $${dailyCapUsd.toFixed(2)}`,
      });
      return { ok: false, reason: 'agent daily spend cap reached' };
    }
    return { ok: true };
  }

  private async start(entry: QueueEntry): Promise<void> {
    const { req } = entry;
    const agentRow = getAgent(this.rt.db, req.agentId);
    if (!agentRow) {
      entry.reject(new Error('agent vanished before start'));
      return;
    }
    const project = getProject(this.rt.db, agentRow.projectId);
    if (!project) {
      entry.reject(new Error('project vanished before start'));
      return;
    }
    if (!existsSync(project.path)) {
      this.rt.event({
        agentId: agentRow.id,
        level: 'error',
        message: `project path is missing: ${project.path}`,
      });
      entry.reject(new Error(`project path is missing: ${project.path}`));
      return;
    }

    const sessionId = ids.session();
    const abort = new AbortController();
    const transcript = new TranscriptWriter(sessionId);
    const startedAt = Date.now();

    this.rt.db
      .insert(sessions)
      .values({
        id: sessionId,
        agentId: agentRow.id,
        claudeSessionId: null,
        startedAt,
        costUsd: 0,
        turns: 0,
        transcriptPath: transcript.path,
        trigger: req.trigger,
      })
      .run();

    const liveSession: LiveSession = {
      sessionId,
      agentId: agentRow.id,
      abort,
      startedAt,
      turns: 0,
      transcript,
      finalized: false,
    };
    this.live.set(sessionId, liveSession);
    this.setAgentStatus(agentRow.id, 'running', sessionId);
    this.rt.event({
      agentId: agentRow.id,
      message: `session started (${req.trigger}) — ${agentRow.name} in ${project.name}`,
    });

    const allowlist = safeArray(agentRow.allowlistJson, ['Read', 'Grep', 'Glob']);
    const allowedDomains = safeArray(agentRow.allowedDomainsJson, []);
    const promptAgent = {
      name: agentRow.name,
      role: agentRow.role,
      mission: agentRow.mission,
      autonomy: agentRow.autonomy,
      allowlist,
    };

    const prompt =
      req.prompt ??
      (req.trigger === 'heartbeat'
        ? pulsePrompt(promptAgent, new Date(agentRow.lastRunAt ?? startedAt).toISOString())
        : missionPrompt(promptAgent, req.instruction));

    let seq = 0;
    const gateItemIds: string[] = [];

    // A loop may override billing for its own runs; the agent's setting is the
    // default, and subscription is the default for both.
    const billing: 'subscription' | 'api' =
      req.billing ?? (agentRow.billing === 'api' ? 'api' : 'subscription');

    const spec: RunSpec = {
      sessionId,
      agentId: agentRow.id,
      agentName: agentRow.name,
      cwd: project.path,
      prompt,
      model: agentRow.model,
      systemPromptAppend: this.protocolFor(project),
      allowlist,
      allowedDomains,
      autonomy: agentRow.autonomy,
      maxChildren: agentRow.maxChildren,
      maxTurns: req.maxTurns ?? agentRow.maxTurns,
      resumeSessionId: req.resume === false ? null : agentRow.claudeSessionId,
      billing: billing,
      apiKey: billing === 'api' ? readKeychainKey(agentRow.id) : null,
      signal: abort.signal,
      onRaw: (msg) => transcript.write({ kind: 'raw', at: Date.now(), msg }),
      onMessage: (m) => {
        const at = Date.now();
        // The role-coded line is what the drawer renders; the raw message is
        // already on the previous line, so it is not repeated here.
        transcript.write({ role: m.role, text: m.text, seq, at });
        if (m.role === 'assistant' || m.role === 'tool') liveSession.turns += 1;
        this.rt.send({
          type: 'session.stream',
          sessionId,
          agentId: agentRow.id,
          seq: seq++,
          role: m.role,
          text: m.text,
          at,
        });
      },
      onPermission: async (p) => {
        this.setAgentStatus(agentRow.id, 'waiting-gate', sessionId);
        const { item, decision } = await this.gate.createAndWait({
          agentId: agentRow.id,
          sessionId,
          loopRunId: req.loopRunId ?? null,
          kind: p.kind,
          label: `${p.toolName}: ${shortLabel(p.input)}`,
          detail: p.reason,
          payload: { tool: p.toolName, input: p.input, cwd: project.path },
          source: 'permission-callback',
        });
        gateItemIds.push(item.id);
        this.setAgentStatus(agentRow.id, 'running', sessionId);
        return decision === 'approved'
          ? { behavior: 'allow' as const }
          : { behavior: 'deny' as const, message: denialNote(item.label) };
      },
    };

    let result: RunOutcome;
    try {
      const run = await this.runner.run(spec);
      this.rt.authOk = true;

      // Second enforcement layer: whatever the agent described in its final
      // message becomes gate items too, no matter which runner produced it.
      for (const action of parseProposedActions(run.finalText)) {
        const item = this.gate.create({
          agentId: agentRow.id,
          sessionId,
          loopRunId: req.loopRunId ?? null,
          kind: action.kind,
          label: action.label,
          detail: action.detail,
          payload: action.payload ?? null,
          source: 'proposed-actions',
        });
        gateItemIds.push(item.id);
      }

      this.finalizeSession(liveSession, {
        exitReason: run.exitReason,
        costUsd: run.costUsd,
        turns: run.turns,
        claudeSessionId: run.claudeSessionId,
      });

      if (req.trigger === 'heartbeat' || req.trigger === 'loop') {
        this.writePulse(agentRow.id, sessionId, agentRow.lastRunAt ?? startedAt, run.finalText);
      }

      result = {
        sessionId,
        exitReason: run.exitReason,
        costUsd: run.costUsd,
        turns: run.turns,
        finalText: run.finalText,
        gateItemIds,
      };
      entry.resolve(result);
    } catch (err) {
      const isAuth = err instanceof AuthRequiredError;
      if (isAuth) {
        this.rt.authOk = false;
        // Law 7: say the words, never ask for a key.
        this.rt.event({
          agentId: agentRow.id,
          level: 'critical',
          message: 'AUTH REQUIRED — run `claude login` in a terminal, then resume the fleet.',
        });
      } else {
        this.rt.event({
          agentId: agentRow.id,
          level: 'error',
          message: `session failed: ${(err as Error).message}`,
        });
      }
      this.finalizeSession(liveSession, {
        exitReason: isAuth ? 'auth-required' : 'error',
        costUsd: 0,
        turns: liveSession.turns,
      });
      entry.reject(err as Error);
    } finally {
      this.live.delete(sessionId);
      transcript.close();
      this.pump();
    }
  }

  private finalizeSession(
    s: LiveSession,
    end: {
      exitReason: SessionExitReason;
      costUsd: number;
      turns: number;
      claudeSessionId?: string | null;
    },
  ): void {
    // A killed session is finalized by killAll and then again by its own
    // unwinding run(). Without this guard the cost lands in spend_daily twice.
    if (s.finalized) return;
    s.finalized = true;

    const endedAt = Date.now();
    this.rt.db
      .update(sessions)
      .set({
        endedAt,
        exitReason: end.exitReason,
        costUsd: end.costUsd,
        turns: end.turns,
        claudeSessionId: end.claudeSessionId ?? null,
      })
      .where(eq(sessions.id, s.sessionId))
      .run();

    addSpend(this.rt.db, s.agentId, end.costUsd, endedAt);
    this.gate.expireForSession(s.sessionId);

    const agentPatch: Record<string, unknown> = { lastRunAt: endedAt };
    if (end.claudeSessionId) agentPatch.claudeSessionId = end.claudeSessionId;
    this.rt.db.update(agents).set(agentPatch).where(eq(agents.id, s.agentId)).run();

    const agent = getAgent(this.rt.db, s.agentId);
    const spent = agentSpendToday(this.rt.db, s.agentId, endedAt);
    if (agent && spent >= agent.dailyCapUsd) {
      this.setAgentStatus(s.agentId, 'parked-cap');
      this.rt.event({
        agentId: s.agentId,
        level: 'warn',
        message: `parked at daily cap — $${spent.toFixed(2)} of $${agent.dailyCapUsd.toFixed(2)}`,
      });
    } else if (end.exitReason === 'killed') {
      this.setAgentStatus(s.agentId, 'paused');
    } else if (end.exitReason === 'auth-required' || end.exitReason === 'error') {
      this.setAgentStatus(s.agentId, 'error');
    } else {
      this.setAgentStatus(s.agentId, 'idle');
    }

    const row = this.rt.db.select().from(sessions).where(eq(sessions.id, s.sessionId)).get();
    if (row) {
      this.rt.event({
        agentId: s.agentId,
        message: `session ended (${end.exitReason}) — ${end.turns} turns, $${end.costUsd.toFixed(4)}`,
        data: rowToSession(row),
      });
    }
    this.rt.broadcastFleet({ running: this.live.size, queued: this.queued() });
  }

  /** Law 6: every pulse writes a row, clean or not. */
  private writePulse(agentId: string, sessionId: string, windowStart: number, finalText: string): void {
    const { clean, finding } = readPulseReport(finalText);
    const pulse = {
      id: ids.pulse(),
      agentId,
      sessionId,
      windowStart,
      windowEnd: Date.now(),
      finding,
      clean,
      createdAt: Date.now(),
    };
    this.rt.db.insert(pulses).values(pulse).run();
    this.rt.send({ type: 'pulse.new', pulse });
    this.rt.event({
      agentId,
      level: clean ? 'info' : 'warn',
      message: `pulse ${clean ? 'clean' : 'finding'}: ${finding.slice(0, 200)}`,
    });
  }

  setAgentStatus(agentId: string, status: AgentStatus, sessionId?: string): void {
    this.rt.db.update(agents).set({ status }).where(eq(agents.id, agentId)).run();
    this.rt.send({
      type: 'agent.status',
      agentId,
      status,
      sessionId: sessionId ?? null,
      costUsdToday: agentSpendToday(this.rt.db, agentId),
      at: Date.now(),
    });
  }

  /**
   * HELM.md is regenerated before every session. If the operator (or the agent)
   * removed it, the standing orders come back rather than quietly vanishing.
   */
  private protocolFor(project: { id: string; name: string; path: string }): string {
    try {
      return syncProtocol(this.rt.config.get(), project);
    } catch (err) {
      this.rt.event({
        projectId: project.id,
        level: 'error',
        message: `could not sync HELM.md: ${(err as Error).message}`,
      });
      return '';
    }
  }

  /** Clean up rows left "running" by a bridge that was killed mid-session. */
  reconcileOnBoot(): void {
    const orphans = this.rt.db.select().from(sessions).all().filter((s) => s.endedAt === null);
    for (const s of orphans) {
      this.rt.db
        .update(sessions)
        .set({ endedAt: Date.now(), exitReason: 'killed' })
        .where(eq(sessions.id, s.id))
        .run();
    }
    const killed = this.rt.isKilled();
    for (const a of this.rt.db.select().from(agents).all()) {
      if (a.archivedAt) continue;
      const stuck = a.status === 'running' || a.status === 'queued' || a.status === 'waiting-gate';
      if (killed) this.setAgentStatus(a.id, 'paused');
      else if (stuck) this.setAgentStatus(a.id, 'idle');
    }
    if (orphans.length) {
      this.rt.event({
        level: 'warn',
        message: `${orphans.length} session(s) were interrupted by a bridge restart`,
      });
    }
  }
}

function safeArray(json: string, fallback: string[]): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : fallback;
  } catch {
    return fallback;
  }
}

function shortLabel(input: Record<string, unknown>): string {
  const raw = String(input.command ?? input.file_path ?? input.url ?? input.path ?? '');
  return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw || '(no arguments)';
}

