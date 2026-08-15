import { parseDurationMs, type GateItem } from '@helm/core';
import type { Runtime } from '../runtime.js';
import type { LoopEngine } from './engine.js';
import type { LoopRegistry, LoopRow } from './registry.js';

/**
 * Fires loops on their declared triggers: a clock, an event another loop
 * emitted, or a gate decision. Event edges are what let a detection loop hand
 * off to a fix loop without a human wiring the two together.
 */
export class LoopScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly rt: Runtime,
    private readonly registry: LoopRegistry,
    private readonly engine: LoopEngine,
  ) {
    this.engine.on('loop.event', (e: { event: string }) => this.onEvent(e.event));
  }

  start(tickMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()): void {
    if (this.rt.isKilled()) return;
    for (const loop of this.registry.list()) {
      if (loop.status !== 'enabled') continue;
      if (loop.definition.trigger.type !== 'cron') continue;
      if (!isCronDue(loop, now)) continue;
      void this.fire(loop, 'cron');
    }
  }

  onEvent(event: string): void {
    if (this.rt.isKilled()) return;
    for (const loop of this.registry.list()) {
      if (loop.status !== 'enabled') continue;
      const t = loop.definition.trigger;
      if (t.type === 'event' && t.on === event) void this.fire(loop, `event:${event}`);
    }
  }

  /** A decision both resumes parked runs and can trigger fresh ones. */
  async onGateDecision(item: GateItem): Promise<void> {
    await this.engine.resumeFromGate(item.id);
    if (this.rt.isKilled()) return;

    for (const loop of this.registry.list()) {
      if (loop.status !== 'enabled') continue;
      const t = loop.definition.trigger;
      if (t.type === 'gate' && item.status === t.on) void this.fire(loop, `gate:${t.on}`);
    }
  }

  private async fire(loop: LoopRow, trigger: string): Promise<void> {
    const res = await this.engine.run(loop.id, trigger);
    if ('refused' in res) {
      this.rt.event({ level: 'debug', message: `loop ${loop.name} not run: ${res.refused}` });
    }
  }
}

export function isCronDue(loop: LoopRow, now: number): boolean {
  const t = loop.definition.trigger;
  if (t.type !== 'cron') return false;

  if (t.every) {
    const period = parseDurationMs(t.every);
    return (loop.lastRunAt ?? 0) + period <= now;
  }

  if (t.at) {
    const [h, m] = t.at.split(':').map(Number) as [number, number];
    const d = new Date(now);
    if (t.days && !t.days.includes(d.getDay())) return false;
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (now < target.getTime()) return false;
    return (loop.lastRunAt ?? 0) < target.getTime();
  }

  return false;
}
