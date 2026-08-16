import { eq } from 'drizzle-orm';
import type { Runtime } from './runtime.js';
import type { Supervisor } from './supervisor.js';
import { agents } from './db/schema.js';
import { agentSpendToday, startOfLocalDay } from './repo.js';

export interface SchedulerOptions {
  /** How often the scheduler looks for due agents. */
  tickMs?: number;
}

/**
 * Wakes agents on their heartbeat. The scheduler decides *whether* an agent is
 * due; the supervisor decides whether there is room to run it. Keeping those
 * separate is why a 1-minute heartbeat with a governor of 2 interleaves
 * correctly instead of stampeding.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastUnparkDay = 0;
  private readonly tickMs: number;

  constructor(
    private readonly rt: Runtime,
    private readonly sup: Supervisor,
    opts?: SchedulerOptions,
  ) {
    this.tickMs = opts?.tickMs ?? 15_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests: run one pass synchronously. */
  tick(at = Date.now()): void {
    this.unparkForNewDay(at);
    if (this.rt.isKilled()) return;

    const due = this.dueAgents(at);
    for (const a of due) {
      this.sup
        .request({ agentId: a.id, trigger: 'heartbeat' })
        .catch((err: Error) => {
          // Cap reached, already live, fleet killed — all expected, all logged
          // by whoever refused. A heartbeat that cannot run is not an error.
          this.rt.event({
            agentId: a.id,
            level: 'debug',
            message: `heartbeat skipped: ${err.message}`,
          });
        });
    }
  }

  private dueAgents(at: number): Array<typeof agents.$inferSelect> {
    return this.rt.db
      .select()
      .from(agents)
      .all()
      .filter((a) => {
        if (a.archivedAt) return false;
        if (a.heartbeatMinutes <= 0) return false;
        // 'error' is eligible: one bad session must not silence an agent
        // forever. It retries on its next heartbeat like anything else.
        // 'paused' and 'parked-cap' are deliberate states and stay put.
        if (a.status !== 'idle' && a.status !== 'error') return false;
        const last = a.lastRunAt ?? 0;
        return at - last >= a.heartbeatMinutes * 60_000;
      });
  }

  /**
   * Law 4's other half: a parked agent must come back on its own the next day,
   * without the operator remembering to unpark it.
   */
  private unparkForNewDay(at: number): void {
    const today = startOfLocalDay(at);
    if (this.lastUnparkDay === today) return;
    this.lastUnparkDay = today;

    for (const a of this.rt.db.select().from(agents).all()) {
      if (a.archivedAt || a.status !== 'parked-cap') continue;
      if (agentSpendToday(this.rt.db, a.id, at) < a.dailyCapUsd) {
        this.rt.db.update(agents).set({ status: 'idle' }).where(eq(agents.id, a.id)).run();
        this.rt.event({ agentId: a.id, message: `${a.name} unparked — new day, fresh budget` });
      }
    }
  }
}
