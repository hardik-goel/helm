import { desc, eq } from 'drizzle-orm';
import type { Runtime } from '../runtime.js';
import { loopRuns } from '../db/schema.js';
import type { LoopEngine, StepTrace } from './engine.js';
import type { LoopRegistry } from './registry.js';

export interface WatchdogVerdict {
  loopId: string;
  loopName: string;
  reason: string;
}

const DEFAULT_EXPECTED_MS = 5 * 60_000;
const THRASH_RUNS = 3;

/** Outcomes that mean the loop actually got somewhere. */
const RESOLVING_OUTCOMES = new Set(['fix-verified', 'ticket-filed', 'short-circuited']);

/**
 * Someone must watch the watchers, and it must not be an LLM.
 *
 * This is plain arithmetic over the run history: a loop that runs too long,
 * costs too much, or keeps rediscovering the same thing gets parked and a
 * banner goes up. No model is asked for an opinion.
 */
export class LoopWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly rt: Runtime,
    private readonly registry: LoopRegistry,
    private readonly engine: LoopEngine,
  ) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Returns everything it parked. */
  sweep(now = Date.now()): WatchdogVerdict[] {
    const parked: WatchdogVerdict[] = [];

    for (const loop of this.registry.list()) {
      if (loop.status !== 'enabled') continue;
      const runs = this.rt.db
        .select()
        .from(loopRuns)
        .where(eq(loopRuns.loopId, loop.id))
        .orderBy(desc(loopRuns.startedAt))
        .limit(20)
        .all();

      const reason =
        this.stuck(runs, now) ?? this.costAnomaly(runs) ?? this.thrash(runs);
      if (!reason) continue;

      this.registry.setStatus(loop.id, 'parked', reason);
      this.rt.event({ level: 'critical', message: `LOOP PARKED — ${loop.name}: ${reason}` });
      parked.push({ loopId: loop.id, loopName: loop.name, reason });
    }

    return parked;
  }

  /** Running far longer than this loop's own history says it should. */
  private stuck(runs: Array<typeof loopRuns.$inferSelect>, now: number): string | null {
    const live = runs.find((r) => !r.endedAt);
    if (!live) return null;
    // Waiting on a human is not being stuck. People sleep.
    if (live.waitingGateId) return null;

    const durations = runs
      .filter((r) => r.endedAt)
      .map((r) => r.endedAt! - r.startedAt)
      .filter((d) => d > 0);
    const expected = durations.length >= 3 ? median(durations) : DEFAULT_EXPECTED_MS;
    const elapsed = now - live.startedAt;
    if (elapsed <= expected * 2) return null;
    return `run has been going ${Math.round(elapsed / 60_000)}m, over 2× its typical ${Math.round(expected / 60_000)}m`;
  }

  /** A run that suddenly costs multiples of the norm is a bug, not a workload. */
  private costAnomaly(runs: Array<typeof loopRuns.$inferSelect>): string | null {
    const done = runs.filter((r) => r.endedAt);
    if (done.length < 4) return null;
    const [latest, ...rest] = done;
    const trailing = rest.map((r) => r.costUsd).filter((c) => c > 0);
    if (trailing.length < 3) return null;
    const med = median(trailing);
    if (med <= 0 || latest!.costUsd <= med * 3) return null;
    return `last run cost $${latest!.costUsd.toFixed(2)}, over 3× the trailing median of $${med.toFixed(2)}`;
  }

  /**
   * The same finding, run after run, means nothing is actually being fixed.
   *
   * A run that resolved the finding breaks the chain, even if the same signal
   * reappears afterwards: rediscovering a regression you previously fixed is
   * the loop working, not thrashing. Only unresolved repeats count.
   */
  private thrash(runs: Array<typeof loopRuns.$inferSelect>): string | null {
    const done = runs.filter((r) => r.endedAt).slice(0, THRASH_RUNS);
    if (done.length < THRASH_RUNS) return null;
    if (done.some((r) => RESOLVING_OUTCOMES.has(r.outcome ?? ''))) return null;

    const sigs = done.map((r) => signatureOf(r.stepsTraceJson));
    if (sigs.some((s) => s === null)) return null;
    if (new Set(sigs).size !== 1) return null;
    return `the same finding has come back ${THRASH_RUNS} runs in a row without being resolved`;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A stable fingerprint of what a run found. Explicit `signature` wins; failing
 * that, the first executed step's output with volatile keys stripped.
 */
export function signatureOf(stepsTraceJson: string): string | null {
  let trace: StepTrace[];
  try {
    trace = JSON.parse(stepsTraceJson) as StepTrace[];
  } catch {
    return null;
  }
  const first = trace.find((t) => t.ran && t.output);
  if (!first) return null;

  const out = { ...(first.output as Record<string, unknown>) };
  if (typeof out.signature === 'string') return out.signature;
  delete out.memory;
  delete out.last_run;
  delete out.outcome;
  return stableStringify(out);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
