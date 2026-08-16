import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, spendDaily } from './db/schema.js';
import { Scheduler } from './scheduler.js';
import { FakeRunner, makeHarness, okResult, type Harness } from './test-harness.js';
import { localDate } from './repo.js';

const open: Harness[] = [];
function harness(runner: FakeRunner, opts?: { maxConcurrent?: number }) {
  const h = makeHarness(runner, opts);
  open.push(h);
  return h;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('Phase 3 — heartbeat scheduler', () => {
  it('wakes an agent whose heartbeat is due, and not one that is not', async () => {
    const runner = new FakeRunner(async () => okResult({ finalText: 'CLEAN: ok.' }));
    const h = harness(runner);
    const p = h.addProject();
    const due = h.addAgent(p, { name: 'due', heartbeatMinutes: 1 });
    const notDue = h.addAgent(p, { name: 'not-due', heartbeatMinutes: 60 });
    const manual = h.addAgent(p, { name: 'manual', heartbeatMinutes: 0 });

    const now = Date.now();
    h.db.update(agents).set({ lastRunAt: now - 90_000 }).where(eq(agents.id, due)).run();
    h.db.update(agents).set({ lastRunAt: now - 90_000 }).where(eq(agents.id, notDue)).run();
    h.db.update(agents).set({ lastRunAt: now - 90_000 }).where(eq(agents.id, manual)).run();

    new Scheduler(h.rt, h.sup).tick(now);
    await vi.waitFor(() => expect(runner.specs.length).toBeGreaterThan(0));

    expect(runner.specs.map((s) => s.agentName)).toEqual(['due']);
  });

  it('never wakes an agent that is already running or queued', async () => {
    const hold: Array<() => void> = [];
    const runner = new FakeRunner(async () => {
      await new Promise<void>((r) => hold.push(r));
      return okResult();
    });
    const h = harness(runner);
    const a = h.addAgent(h.addProject(), { heartbeatMinutes: 1 });

    const first = h.sup.request({ agentId: a, trigger: 'manual' });
    await vi.waitFor(() => expect(hold).toHaveLength(1));

    new Scheduler(h.rt, h.sup).tick(Date.now());
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.specs).toHaveLength(1);

    hold[0]!();
    await first;
  });

  it('does not wake anything while the fleet is killed', async () => {
    const runner = new FakeRunner(async () => okResult());
    const h = harness(runner);
    const a = h.addAgent(h.addProject(), { heartbeatMinutes: 1 });
    h.db.update(agents).set({ lastRunAt: 0 }).where(eq(agents.id, a)).run();
    h.rt.setKilled(true, 'test');

    new Scheduler(h.rt, h.sup).tick(Date.now());
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.specs).toHaveLength(0);
  });

  it('interleaves three due agents through a governor of two', async () => {
    const release: Array<() => void> = [];
    const started: string[] = [];
    const runner = new FakeRunner(async (spec) => {
      started.push(spec.agentName);
      await new Promise<void>((r) => release.push(r));
      return okResult();
    });
    const h = harness(runner, { maxConcurrent: 2 });
    const p = h.addProject();
    const ids = ['a', 'b', 'c'].map((n) => h.addAgent(p, { name: n, heartbeatMinutes: 1 }));
    for (const id of ids) {
      h.db.update(agents).set({ lastRunAt: 0 }).where(eq(agents.id, id)).run();
    }

    new Scheduler(h.rt, h.sup).tick(Date.now());
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(h.sup.running()).toBe(2);
    expect(h.sup.queued()).toHaveLength(1);

    release.shift()!();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    release.forEach((r) => r());
  });

  it('unparks a capped agent when a new day starts', async () => {
    const runner = new FakeRunner(async () => okResult());
    const h = harness(runner);
    const a = h.addAgent(h.addProject(), { heartbeatMinutes: 1, dailyCapUsd: 1 });

    h.db.update(agents).set({ status: 'parked-cap' }).where(eq(agents.id, a)).run();
    // Yesterday's spend, which must not count against today's budget.
    h.db
      .insert(spendDaily)
      .values({ date: localDate(Date.now() - 86_400_000), agentId: a, costUsd: 9 })
      .run();

    new Scheduler(h.rt, h.sup).tick(Date.now());
    expect(h.db.select().from(agents).where(eq(agents.id, a)).get()!.status).not.toBe('parked-cap');
  });

  it('leaves an agent parked when today’s spend is still over the cap', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject(), { heartbeatMinutes: 1, dailyCapUsd: 1 });

    h.db.update(agents).set({ status: 'parked-cap' }).where(eq(agents.id, a)).run();
    h.db.insert(spendDaily).values({ date: localDate(), agentId: a, costUsd: 5 }).run();

    new Scheduler(h.rt, h.sup).tick(Date.now());
    expect(h.db.select().from(agents).where(eq(agents.id, a)).get()!.status).toBe('parked-cap');
  });
});
