import { and, desc, eq, sql } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import {
  ids,
  type LoopDefinition,
  type LoopRunOutcome,
  type LoopStep,
} from '@helm/core';
import type { Runtime } from '../runtime.js';
import type { Supervisor } from '../supervisor.js';
import type { GateService } from '../gate-service.js';
import { gateItems, loopMemory, loopRuns, loops } from '../db/schema.js';
import { localDate } from '../repo.js';
import { evaluateGuard, type Scope } from './expr.js';
import type { LoopRegistry, LoopRow } from './registry.js';

export interface StepTrace {
  index: number;
  agent: string;
  ran: boolean;
  skippedBecause?: string;
  outputKey?: string;
  output?: unknown;
  costUsd?: number;
  sessionId?: string;
  gateItemIds?: string[];
  error?: string;
}

export interface LoopRunResult {
  runId: string;
  outcome: LoopRunOutcome;
  costUsd: number;
  trace: StepTrace[];
  waitingGateId?: string;
}

const OUTPUT_HEADING = '## OUTPUT';

/**
 * The difference between a loop and a cron job is this class: memory goes in
 * before the first step and learnings come back out after the last one, so run
 * forty is cheaper and sharper than run one.
 */
export class LoopEngine extends EventEmitter {
  constructor(
    private readonly rt: Runtime,
    private readonly registry: LoopRegistry,
    private readonly sup: Supervisor,
    private readonly gate: GateService,
  ) {
    super();
  }

  /* ---------------- memory ---------------- */

  readMemory(loopId: string): Record<string, unknown> {
    const rows = this.rt.db.select().from(loopMemory).where(eq(loopMemory.loopId, loopId)).all();
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.valueJson);
      } catch {
        out[r.key] = r.valueJson;
      }
    }
    return out;
  }

  /**
   * Wipe what a loop has learned. Compounding memory is an asset right up
   * until it compounds a wrong belief, so the operator needs a reset.
   */
  clearMemory(loopId: string): number {
    const rows = this.rt.db.select().from(loopMemory).where(eq(loopMemory.loopId, loopId)).all();
    this.rt.db.delete(loopMemory).where(eq(loopMemory.loopId, loopId)).run();
    this.rt.event({ level: 'warn', message: `loop memory cleared (${rows.length} keys)` });
    return rows.length;
  }

  writeMemory(loopId: string, patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
      this.rt.db
        .insert(loopMemory)
        .values({ loopId, key, valueJson: JSON.stringify(value), updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [loopMemory.loopId, loopMemory.key],
          set: { valueJson: JSON.stringify(value), updatedAt: Date.now() },
        })
        .run();
    }
  }

  /* ---------------- running ---------------- */

  async run(
    loopIdOrName: string,
    trigger = 'manual',
  ): Promise<LoopRunResult | { refused: string }> {
    const loop0 = this.registry.get(loopIdOrName);
    if (!loop0) return { refused: 'no such loop' };
    if (this.rt.isKilled()) return { refused: 'fleet is killed' };

    // Roll the day BEFORE reading status: a loop parked for exhausting
    // yesterday's budget must be able to come back this morning, and it cannot
    // do that if the parked check runs first.
    this.rollDay(loop0);
    const loop = this.registry.get(loop0.id)!;

    if (loop.status === 'disabled' && trigger !== 'manual') {
      return { refused: 'loop is disabled' };
    }
    if (loop.status === 'parked') return { refused: `loop is parked: ${loop.parkedReason ?? ''}` };

    const fresh = loop;

    if (fresh.iterationsToday >= fresh.definition.bounds.max_iterations_per_day) {
      this.finishWithoutRunning(fresh, 'iterations-capped');
      return { refused: 'max iterations for today reached' };
    }
    if (fresh.spendTodayUsd >= fresh.definition.bounds.budget_per_day_usd) {
      this.registry.setStatus(fresh.id, 'parked', 'daily budget exhausted');
      this.finishWithoutRunning(fresh, 'budget-exhausted');
      return { refused: 'daily budget exhausted — loop parked' };
    }

    const runId = ids.loopRun();
    const memory = fresh.definition.memory ? this.readMemory(fresh.id) : {};
    const scope: Scope = { memory, run: { trigger, iteration: fresh.iterationsToday + 1 } };

    this.rt.db
      .insert(loopRuns)
      .values({
        id: runId,
        loopId: fresh.id,
        triggerDetail: trigger,
        startedAt: Date.now(),
        stepsTraceJson: '[]',
        scopeJson: JSON.stringify(scope),
        costUsd: 0,
      })
      .run();

    this.rt.db
      .update(loops)
      .set({ iterationsToday: fresh.iterationsToday + 1, lastRunAt: Date.now() })
      .where(eq(loops.id, fresh.id))
      .run();

    this.rt.event({ message: `loop ${fresh.name} run started (${trigger})` });
    return this.executeFrom(fresh, runId, scope, [], 0, 0);
  }

  /** Resume a run parked at the gate. Called when a human decides. */
  async resumeFromGate(gateItemId: string): Promise<LoopRunResult | null> {
    const run = this.rt.db
      .select()
      .from(loopRuns)
      .where(eq(loopRuns.waitingGateId, gateItemId))
      .get();
    if (!run || run.endedAt) return null;

    const loop = this.registry.get(run.loopId);
    if (!loop) return null;

    const item = this.gate.get(gateItemId);
    const approved = item?.status === 'approved';

    const scope = JSON.parse(run.scopeJson) as Scope;
    scope.gate = { approved, denied: !approved, id: gateItemId };
    const trace = JSON.parse(run.stepsTraceJson) as StepTrace[];

    if (!approved) {
      this.rt.event({
        level: 'warn',
        message: `loop ${loop.name} halted — the operator denied its staged action`,
      });
      return this.finishRun(loop, run.id, 'parked', run.costUsd, trace);
    }

    this.rt.db
      .update(loopRuns)
      .set({ waitingGateId: null, scopeJson: JSON.stringify(scope) })
      .where(eq(loopRuns.id, run.id))
      .run();

    return this.executeFrom(
      loop,
      run.id,
      scope,
      trace,
      (run.resumeStepIndex ?? 0) + 1,
      run.costUsd,
    );
  }

  private async executeFrom(
    loop: LoopRow,
    runId: string,
    scope: Scope,
    trace: StepTrace[],
    startIndex: number,
    costSoFar: number,
  ): Promise<LoopRunResult> {
    const def = loop.definition;
    let cost = costSoFar;

    for (let i = startIndex; i < def.steps.length; i++) {
      const step = def.steps[i]!;

      if (cost >= def.bounds.budget_per_run_usd) {
        this.rt.event({
          level: 'warn',
          message: `loop ${loop.name} stopped at its per-run budget ($${cost.toFixed(2)})`,
        });
        return this.finishRun(loop, runId, 'budget-exhausted', cost, trace);
      }

      const guard = evaluateGuard(step.when, scope);
      if (!guard.value) {
        trace.push({
          index: i,
          agent: step.agent,
          ran: false,
          skippedBecause: guard.error ? `guard error: ${guard.error}` : `when: ${step.when}`,
        });
        if (guard.error) {
          this.rt.event({
            level: 'error',
            message: `loop ${loop.name} step ${i} guard failed to parse: ${guard.error}`,
          });
        }
        continue;
      }

      const agentId = this.registry.resolveAgentId(step.agent);
      if (!agentId) {
        trace.push({ index: i, agent: step.agent, ran: false, error: 'no such agent' });
        this.registry.setStatus(loop.id, 'parked', `step ${i} names an unknown agent: ${step.agent}`);
        return this.finishRun(loop, runId, 'error', cost, trace);
      }

      let outcomeStep: StepTrace;
      try {
        const result = await this.sup.request({
          agentId,
          trigger: 'loop',
          loopRunId: runId,
          prompt: this.stepPrompt(def, step, scope, i),
          maxTurns: step.maxTurns,
          billing: def.billing,
        });
        cost += result.costUsd;

        const output = parseStepOutput(result.finalText);
        if (step.output) scope[step.output] = output;
        this.absorbMemory(loop, output);

        outcomeStep = {
          index: i,
          agent: step.agent,
          ran: true,
          outputKey: step.output,
          output,
          costUsd: result.costUsd,
          sessionId: result.sessionId,
          gateItemIds: result.gateItemIds,
        };
        trace.push(outcomeStep);

        for (const e of step.emits) {
          this.emit('loop.event', { event: e, loop: loop.name, runId, output });
        }

        // A gated step parks the run until a human decides. The parked state
        // lives in the database, so a bridge restart does not lose it.
        const pending = (result.gateItemIds ?? []).filter((id) => {
          const g = this.gate.get(id);
          return g?.status === 'pending';
        });
        if (step.gated && pending.length > 0) {
          this.rt.db
            .update(loopRuns)
            .set({
              waitingGateId: pending[0]!,
              resumeStepIndex: i,
              scopeJson: JSON.stringify(scope),
              stepsTraceJson: JSON.stringify(trace),
              costUsd: cost,
            })
            .where(eq(loopRuns.id, runId))
            .run();

          this.registry.broadcast(this.registry.get(loop.id)!, 'waiting at the gate');
          this.rt.event({
            level: 'warn',
            message: `loop ${loop.name} parked at the gate — ${pending.length} decision(s) waiting`,
          });
          return { runId, outcome: 'waiting-gate', costUsd: cost, trace, waitingGateId: pending[0]! };
        }
      } catch (err) {
        const message = (err as Error).message;
        trace.push({ index: i, agent: step.agent, ran: false, error: message });

        // A step refused by a spend cap is Law 4 working, not a broken loop.
        // It stops and reports under its own exit condition instead of
        // masquerading as an error the operator has to go debug.
        const capped = /spend cap|budget/i.test(message);
        this.rt.event({
          level: capped ? 'warn' : 'error',
          message: capped
            ? `loop ${loop.name} stopped at step ${i}: ${message}`
            : `loop ${loop.name} step ${i} failed: ${message}`,
        });
        return this.finishRun(loop, runId, capped ? 'budget-exhausted' : 'error', cost, trace);
      }
    }

    const { outcome, warning } = deriveOutcome(def, trace);
    if (warning) this.rt.event({ level: 'warn', message: `loop ${loop.name}: ${warning}` });
    return this.finishRun(loop, runId, outcome, cost, trace);
  }

  /* ---------------- prompts ---------------- */

  private stepPrompt(def: LoopDefinition, step: LoopStep, scope: Scope, index: number): string {
    // Attribute every prior result to the agent and step that produced it.
    // Unattributed output reads as a claim about the reader's own past actions,
    // and an agent that is told it did something it never did is right to
    // distrust the whole prompt.
    const byKey = new Map<string, { agent: string; step: number }>();
    def.steps.forEach((s, n) => {
      if (s.output) byKey.set(s.output, { agent: s.agent, step: n + 1 });
    });

    const priorKeys = Object.keys(scope).filter((k) => !['memory', 'run', 'gate'].includes(k));
    const prior = priorKeys.length
      ? priorKeys
          .map((k) => {
            const src = byKey.get(k);
            const who = src
              ? `${k} — produced by ${src.agent} in step ${src.step}${src.agent === step.agent ? ' (that was you)' : ' (not you)'}`
              : `${k} — source unknown`;
            return `- ${who}:\n  ${JSON.stringify(scope[k]).slice(0, 1500)}`;
          })
          .join('\n')
      : '(this is the first step)';

    const memory = def.memory
      ? JSON.stringify(scope.memory ?? {}, null, 1).slice(0, 6000)
      : '(memory disabled for this loop)';

    return [
      `You are executing step ${index + 1} of the "${def.name}" loop.`,
      '',
      '## LOOP MEMORY — what previous runs already learned',
      'Read this before doing anything. Do not re-investigate a signature marked',
      'resolved or known-noise; recognise it and short-circuit instead.',
      '```json',
      memory,
      '```',
      '',
      '## RESULTS FROM EARLIER STEPS IN THIS RUN',
      'These are reports from other agents in this loop, not a record of your own',
      'actions. Treat them as claims to check, not as facts about what you did.',
      prior,
      '',
      '## YOUR TASK',
      step.do,
      '',
      '## HOW TO REPLY',
      `End your message with a ${OUTPUT_HEADING} block: a single fenced JSON object.`,
      'It is the only part the loop reads. Include the fields the next step needs,',
      'and add these when they apply:',
      '  "short_circuit": true   — this was already resolved; the loop should stop',
      '  "memory": { ... }       — learnings to carry into every future run',
      `  "outcome": "..."        — one of: ${def.exit.join(', ')}`,
      '',
      `${OUTPUT_HEADING}`,
      '```json',
      '{ "example": "replace this with your real output" }',
      '```',
      '',
      'Anything outside your tool allowlist must go in a ## PROPOSED ACTIONS block',
      'for a human to approve. Never attempt it directly.',
    ].join('\n');
  }

  /* ---------------- bookkeeping ---------------- */

  private absorbMemory(loop: LoopRow, output: Record<string, unknown>): void {
    if (!loop.definition.memory) return;
    const mem = output.memory;
    if (mem && typeof mem === 'object' && !Array.isArray(mem)) {
      this.writeMemory(loop.id, mem as Record<string, unknown>);
    }
  }

  private finishRun(
    loop: LoopRow,
    runId: string,
    outcome: LoopRunOutcome,
    cost: number,
    trace: StepTrace[],
  ): LoopRunResult {
    this.rt.db
      .update(loopRuns)
      .set({
        endedAt: Date.now(),
        outcome,
        costUsd: cost,
        stepsTraceJson: JSON.stringify(trace),
        waitingGateId: null,
      })
      .where(eq(loopRuns.id, runId))
      .run();

    // Increment in SQL, not read-modify-write: two runs of the same loop can
    // finish close enough together to lose one of the costs otherwise.
    this.rt.db
      .update(loops)
      .set({ spendTodayUsd: sql`${loops.spendTodayUsd} + ${cost}`, lastOutcome: outcome })
      .where(eq(loops.id, loop.id))
      .run();

    if (loop.definition.memory) {
      this.writeMemory(loop.id, {
        last_run: { at: Date.now(), outcome, costUsd: Number(cost.toFixed(4)) },
      });
    }

    // Law 6 applies to loops too: every run says something, even a quiet one.
    this.rt.event({
      level: outcome === 'error' ? 'error' : outcome === 'clean' ? 'info' : 'warn',
      message: `loop ${loop.name} run ended: ${outcome} ($${cost.toFixed(4)})`,
    });

    const updated = this.registry.get(loop.id)!;
    if (updated.spendTodayUsd >= updated.definition.bounds.budget_per_day_usd) {
      this.registry.setStatus(updated.id, 'parked', 'daily budget exhausted');
    } else {
      this.registry.broadcast(updated, outcome);
    }

    this.emit('loop.finished', { loop: loop.name, runId, outcome, cost });
    return { runId, outcome, costUsd: cost, trace };
  }

  private finishWithoutRunning(loop: LoopRow, outcome: LoopRunOutcome): void {
    this.rt.db.update(loops).set({ lastOutcome: outcome }).where(eq(loops.id, loop.id)).run();
    this.rt.event({ level: 'warn', message: `loop ${loop.name} did not run: ${outcome}` });
    this.registry.broadcast(this.registry.get(loop.id)!, outcome);
  }

  /** Reset the per-day counters when the local date rolls over. */
  private rollDay(loop: LoopRow, at = Date.now()): void {
    const row = this.rt.db.select().from(loops).where(eq(loops.id, loop.id)).get();
    if (!row) return;
    const today = localDate(at);
    if (row.iterationsDate === today) return;
    this.rt.db
      .update(loops)
      .set({
        iterationsDate: today,
        iterationsToday: 0,
        spendTodayUsd: 0,
        parkedReason: row.parkedReason === 'daily budget exhausted' ? null : row.parkedReason,
        status: row.parkedReason === 'daily budget exhausted' ? 'enabled' : row.status,
      })
      .where(eq(loops.id, loop.id))
      .run();
  }

  /** Runs parked at the gate, restored after a bridge restart. */
  pendingGateRuns(): Array<{ runId: string; gateItemId: string; loopId: string }> {
    return this.rt.db
      .select()
      .from(loopRuns)
      .all()
      .filter((r) => !r.endedAt && r.waitingGateId)
      .map((r) => ({ runId: r.id, gateItemId: r.waitingGateId!, loopId: r.loopId }));
  }

  recentRuns(loopId: string, limit = 20) {
    return this.rt.db
      .select()
      .from(loopRuns)
      .where(eq(loopRuns.loopId, loopId))
      .orderBy(desc(loopRuns.startedAt))
      .limit(limit)
      .all();
  }

  /** Gate items still pending for a given loop run. */
  pendingItemsFor(runId: string): number {
    return this.rt.db
      .select()
      .from(gateItems)
      .where(and(eq(gateItems.loopRunId, runId), eq(gateItems.status, 'pending')))
      .all().length;
  }
}

/**
 * Read the `## OUTPUT` block. Falls back to a plain text object so a step that
 * forgets the contract still produces something the next guard can inspect.
 */
export function parseStepOutput(finalText: string): Record<string, unknown> {
  const text = finalText ?? '';
  const idx = text.toUpperCase().lastIndexOf(OUTPUT_HEADING);
  if (idx !== -1) {
    const after = text.slice(idx + OUTPUT_HEADING.length);
    const fenced = after.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced?.[1] ?? after.trim();
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to the text form */
    }
  }
  const clean = /^\s*CLEAN\s*:/i.test(text);
  return { text: text.slice(0, 2000), clean, novel: clean ? 0 : 1 };
}

const KNOWN_OUTCOMES = [
  'clean',
  'ticket-filed',
  'fix-verified',
  'budget-exhausted',
  'iterations-capped',
];

/**
 * The run's verdict belongs to the step that ran LAST.
 *
 * An early step announcing "fix-verified" is announcing its own hope; the
 * verify step at the end is the one that actually looked. Reading outcomes
 * front-to-back let an optimistic middle step overrule a final step that
 * explicitly declined to certify — so this reads them backwards.
 */
function deriveOutcome(
  def: LoopDefinition,
  trace: StepTrace[],
): { outcome: LoopRunOutcome; warning?: string } {
  const ran = trace.filter((t) => t.ran);
  const outputs = ran.map((t) => (t.output ?? {}) as Record<string, unknown>);

  // Short-circuiting means the loop recognised the situation from memory and
  // did no work. If later steps ran, work happened — whatever a step called it.
  if (outputs.length === 1 && outputs[0]!.short_circuit === true) {
    return { outcome: 'short-circuited' };
  }

  for (let i = outputs.length - 1; i >= 0; i--) {
    const declared = typeof outputs[i]!.outcome === 'string' ? (outputs[i]!.outcome as string) : null;
    if (!declared) continue;
    if (!def.exit.includes(declared)) {
      return {
        outcome: 'clean',
        warning: `step ${ran[i]!.index} reported outcome "${declared}", which is not one of this loop's exit conditions (${def.exit.join(', ')})`,
      };
    }
    if (KNOWN_OUTCOMES.includes(declared)) return { outcome: declared as LoopRunOutcome };
    return { outcome: 'clean' };
  }
  return { outcome: 'clean' };
}
