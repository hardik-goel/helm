import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopRuns } from '../db/schema.js';
import { LoopEngine, parseStepOutput } from './engine.js';
import { isCronDue } from './scheduler.js';
import { signatureOf } from './watchdog.js';
import {
  FakeRunner,
  makeHarness,
  makeLoops,
  okResult,
  type Harness,
  type LoopKit,
} from '../test-harness.js';
import type { RunSpec } from '../runner/types.js';

const open: Harness[] = [];
function harness(runner: FakeRunner): Harness & { loops: LoopKit } {
  const h = makeHarness(runner);
  open.push(h);
  return Object.assign(h, { loops: makeLoops(h) });
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** The watchdog loop from the spec, with the agents this harness provides. */
const WATCHDOG = {
  name: 'trinetra-watchdog',
  trigger: { type: 'cron', every: '15m' },
  bounds: {
    max_iterations_per_day: 40,
    budget_per_run_usd: 0.25,
    budget_per_day_usd: 3.0,
  },
  memory: true,
  steps: [
    { agent: 'argus', do: 'Run the standing scan routine.', output: 'findings' },
    {
      when: 'findings.novel > 0',
      agent: 'argus',
      do: 'Root-cause the top novel finding.',
      output: 'diagnosis',
    },
    {
      when: 'diagnosis.fixable',
      agent: 'vesta',
      do: 'Implement the fix on a branch. Stage the push behind the gate.',
      gated: true,
      output: 'fix',
    },
    {
      when: 'gate.approved',
      agent: 'argus',
      do: 'Verify the fix and write the verdict to loop memory.',
      output: 'verdict',
    },
  ],
  exit: ['clean', 'fix-verified', 'budget-exhausted', 'iterations-capped'],
};

function stepIndexOf(spec: RunSpec): number {
  const m = /executing step (\d+)/i.exec(spec.prompt);
  return m ? Number(m[1]) : 0;
}

function memoryFrom(spec: RunSpec): Record<string, unknown> {
  const m = /## LOOP MEMORY[\s\S]*?```json\n([\s\S]*?)\n```/.exec(spec.prompt);
  try {
    return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function output(obj: unknown, extra = ''): string {
  return `Report.\n\n${extra}\n\n## OUTPUT\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
}

const PUSH_PROPOSAL = [
  '## PROPOSED ACTIONS',
  '```json',
  '{"actions":[{"kind":"push","label":"push the fix","payload":{"command":"true"}}]}',
  '```',
].join('\n');

describe('Phase 7 — the loop engine', () => {
  it('runs detect → diagnose → gated fix → verify, then recognises the same signal from memory', async () => {
    const runner = new FakeRunner(async (spec) => {
      const step = stepIndexOf(spec);
      const mem = memoryFrom(spec);
      const resolved = (mem.resolved ?? {}) as Record<string, unknown>;

      if (step === 1) {
        // The compounding bit: a signal already resolved is not novel again.
        if (resolved['build-red']) {
          return okResult({
            costUsd: 0.01,
            finalText: output({
              novel: 0,
              signature: 'build-red',
              short_circuit: true,
              note: 'known-resolved from loop memory',
            }),
          });
        }
        return okResult({
          costUsd: 0.02,
          finalText: output({ novel: 1, signature: 'build-red', detail: 'the build is red' }),
        });
      }
      if (step === 2) {
        return okResult({ costUsd: 0.02, finalText: output({ fixable: true, cause: 'bad import' }) });
      }
      if (step === 3) {
        return okResult({
          costUsd: 0.03,
          finalText: output({ applied: true, branch: 'fix/bad-import' }, PUSH_PROPOSAL),
        });
      }
      return okResult({
        costUsd: 0.02,
        finalText: output({
          verified: true,
          outcome: 'fix-verified',
          memory: { resolved: { 'build-red': { at: 1, verdict: 'fixed' } } },
        }),
      });
    });

    const h = harness(runner);
    const p = h.addProject('trinetra');
    h.addAgent(p, { name: 'argus' });
    h.addAgent(p, { name: 'vesta' });
    const loopId = h.loops.add(WATCHDOG);

    // --- run one: the planted signal ---
    const first = await h.loops.engine.run(loopId, 'test');
    expect('outcome' in first && first.outcome).toBe('waiting-gate');
    if (!('waitingGateId' in first)) throw new Error('expected a parked run');

    const pending = h.gate.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('push');

    h.gate.decide(first.waitingGateId!, 'approved');
    const resumed = await h.loops.engine.resumeFromGate(first.waitingGateId!);
    expect(resumed?.outcome).toBe('fix-verified');

    const memory = h.loops.engine.readMemory(loopId);
    expect(memory.resolved).toMatchObject({ 'build-red': { verdict: 'fixed' } });

    // --- run two: the identical signal, now known ---
    runner.specs.length = 0;
    const second = await h.loops.engine.run(loopId, 'test');
    if (!('outcome' in second)) throw new Error('expected a completed run');

    expect(second.outcome).toBe('short-circuited');
    // Only the scan ran; every downstream step was guarded off.
    expect(runner.specs).toHaveLength(1);
    expect(second.trace.filter((t) => t.ran)).toHaveLength(1);
    expect(second.costUsd).toBeLessThan(first.costUsd);
  });

  it('a parked run survives a bridge restart and resumes on approval', async () => {
    const runner = new FakeRunner(async (spec) =>
      stepIndexOf(spec) === 3
        ? okResult({ finalText: output({ applied: true }, PUSH_PROPOSAL) })
        : okResult({ finalText: output({ novel: 1, fixable: true }) }),
    );
    const h = harness(runner);
    const p = h.addProject();
    h.addAgent(p, { name: 'argus' });
    h.addAgent(p, { name: 'vesta' });
    const loopId = h.loops.add(WATCHDOG);

    const run = await h.loops.engine.run(loopId, 'test');
    if (!('waitingGateId' in run) || !run.waitingGateId) throw new Error('expected a parked run');

    // A brand-new engine, as if the process had restarted.
    const fresh = new LoopEngine(h.rt, h.loops.registry, h.sup, h.gate);
    const parked = fresh.pendingGateRuns();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.gateItemId).toBe(run.waitingGateId);

    h.gate.decide(run.waitingGateId, 'approved');
    const done = await fresh.resumeFromGate(run.waitingGateId);
    expect(done?.outcome).toBeTruthy();
    expect(h.db.select().from(loopRuns).where(eq(loopRuns.id, run.runId)).get()!.endedAt).toBeTruthy();
  });

  it('halts the run when the operator denies the staged action', async () => {
    const runner = new FakeRunner(async (spec) =>
      stepIndexOf(spec) === 3
        ? okResult({ finalText: output({ applied: true }, PUSH_PROPOSAL) })
        : okResult({ finalText: output({ novel: 1, fixable: true }) }),
    );
    const h = harness(runner);
    const p = h.addProject();
    h.addAgent(p, { name: 'argus' });
    h.addAgent(p, { name: 'vesta' });
    const loopId = h.loops.add(WATCHDOG);

    const run = await h.loops.engine.run(loopId, 'test');
    if (!('waitingGateId' in run) || !run.waitingGateId) throw new Error('expected a parked run');

    h.gate.decide(run.waitingGateId, 'denied');
    const after = await h.loops.engine.resumeFromGate(run.waitingGateId);
    expect(after?.outcome).toBe('parked');
    // The verify step never ran, because the fix never landed.
    expect(after?.trace.filter((t) => t.ran).length).toBeLessThan(4);
  });

  it('stops at the per-run budget instead of continuing', async () => {
    const runner = new FakeRunner(async () => okResult({ costUsd: 0.3, finalText: output({ novel: 1, fixable: true }) }));
    const h = harness(runner);
    const p = h.addProject();
    h.addAgent(p, { name: 'argus' });
    h.addAgent(p, { name: 'vesta' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'tight-budget' });

    const run = await h.loops.engine.run(loopId, 'test');
    if (!('outcome' in run)) throw new Error('expected a run');
    expect(run.outcome).toBe('budget-exhausted');
    expect(runner.specs.length).toBeLessThan(4);
  });

  it('parks the loop when the day’s budget is gone', async () => {
    const runner = new FakeRunner(async () => okResult({ costUsd: 0.1, finalText: output({ novel: 0 }) }));
    const h = harness(runner);
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({
      ...WATCHDOG,
      name: 'daily-cap',
      steps: [WATCHDOG.steps[0]],
      bounds: { max_iterations_per_day: 10, budget_per_run_usd: 0.1, budget_per_day_usd: 0.1 },
    });

    await h.loops.engine.run(loopId, 'test');
    expect(h.loops.registry.get(loopId)!.status).toBe('parked');

    const again = await h.loops.engine.run(loopId, 'cron');
    expect('refused' in again && again.refused).toMatch(/parked/);
  });

  it('refuses to exceed its daily iteration cap', async () => {
    const runner = new FakeRunner(async () => okResult({ costUsd: 0.001, finalText: output({ novel: 0 }) }));
    const h = harness(runner);
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({
      ...WATCHDOG,
      name: 'one-a-day',
      steps: [WATCHDOG.steps[0]],
      bounds: { max_iterations_per_day: 1, budget_per_run_usd: 0.5, budget_per_day_usd: 1 },
    });

    await h.loops.engine.run(loopId, 'test');
    const second = await h.loops.engine.run(loopId, 'cron');
    expect('refused' in second && second.refused).toMatch(/iterations/);
  });

  it('will not run while the fleet is killed', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'killed-loop', steps: [WATCHDOG.steps[0]] });
    h.rt.setKilled(true, 'test');

    const res = await h.loops.engine.run(loopId, 'cron');
    expect('refused' in res && res.refused).toMatch(/killed/);
  });

  it('reports a step blocked by an agent spend cap as budget-exhausted, not an error', async () => {
    const runner = new FakeRunner(async () => okResult({ costUsd: 5, finalText: output({ novel: 0 }) }));
    const h = harness(runner);
    const p = h.addProject();
    h.addAgent(p, { name: 'argus', dailyCapUsd: 1 });
    const loopId = h.loops.add({
      ...WATCHDOG,
      name: 'capped-agent',
      // The loop's own budget is generous; the agent's is not.
      bounds: { max_iterations_per_day: 5, budget_per_run_usd: 10, budget_per_day_usd: 20 },
      steps: [WATCHDOG.steps[0], { agent: 'argus', do: 'a second look' }],
    });

    const run = await h.loops.engine.run(loopId, 'test');
    if (!('outcome' in run)) throw new Error('expected a run');
    expect(run.outcome).toBe('budget-exhausted');
    expect(run.trace[1]!.error).toMatch(/cap/);
  });

  it('refuses to enable a loop that names an agent nobody recruited', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    h.addProject();
    const id = h.loops.add({ ...WATCHDOG, name: 'ghosts' }, { enabled: false });
    const res = h.loops.registry.setStatus(id, 'enabled');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/argus/);
  });
});

describe('the run verdict belongs to the step that looked last', () => {
  it('does not let an optimistic early step overrule the final verifier', async () => {
    const runner = new FakeRunner(async (spec) => {
      const step = stepIndexOf(spec);
      if (step === 1) return okResult({ costUsd: 0.01, finalText: output({ novel: 1, fixable: true }) });
      if (step === 2)
        return okResult({ costUsd: 0.01, finalText: output({ fixable: true, outcome: 'fix-verified' }) });
      if (step === 3) return okResult({ costUsd: 0.01, finalText: output({ applied: true }) });
      // The verifier declines to certify.
      return okResult({ costUsd: 0.01, finalText: output({ verified: false, outcome: 'clean' }) });
    });
    const h = harness(runner);
    const p = h.addProject();
    h.addAgent(p, { name: 'argus' });
    h.addAgent(p, { name: 'vesta' });
    const loopId = h.loops.add({
      ...WATCHDOG,
      name: 'honest-verdict',
      steps: WATCHDOG.steps.map((s) => ({ ...s, gated: false, when: s.when === 'gate.approved' ? undefined : s.when })),
    });

    const run = await h.loops.engine.run(loopId, 'test');
    if (!('outcome' in run)) throw new Error('expected a run');
    expect(run.outcome).toBe('clean');
  });

  it('warns when a step reports an outcome the loop never declared', async () => {
    const warnings: string[] = [];
    const runner = new FakeRunner(async () =>
      okResult({ costUsd: 0.01, finalText: output({ outcome: 'something-invented' }) }),
    );
    const h = harness(runner);
    h.addAgent(h.addProject(), { name: 'argus' });
    vi.spyOn(h.rt.hub, 'broadcast').mockImplementation((m) => {
      if (m.type === 'feed.event') warnings.push(m.event.message);
    });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'invented', steps: [WATCHDOG.steps[0]] });

    const run = await h.loops.engine.run(loopId, 'test');
    if (!('outcome' in run)) throw new Error('expected a run');
    expect(run.outcome).toBe('clean');
    expect(warnings.some((w) => w.includes('not one of this loop'))).toBe(true);
  });

  it('tells each agent which of the earlier results were its own', async () => {
    const prompts: string[] = [];
    const runner = new FakeRunner(async (spec) => {
      prompts.push(spec.prompt);
      return okResult({ costUsd: 0.01, finalText: output({ novel: 1, fixable: true }) });
    });
    const h = harness(runner);
    const p = h.addProject();
    h.addAgent(p, { name: 'argus' });
    h.addAgent(p, { name: 'vesta' });
    const loopId = h.loops.add({
      ...WATCHDOG,
      name: 'attribution',
      steps: WATCHDOG.steps.slice(0, 3).map((s) => ({ ...s, gated: false })),
    });

    await h.loops.engine.run(loopId, 'test');

    // vesta's step must not be told that argus's findings were vesta's doing.
    const vestaPrompt = prompts[2]!;
    expect(vestaPrompt).toContain('produced by argus in step 1');
    expect(vestaPrompt).toContain('(not you)');
    expect(vestaPrompt).toContain('not a record of your own');
  });
});

describe('Law 8 — registration refuses unbounded loops', () => {
  it('rejects a YAML missing a budget, with a clear error', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const dir = mkdtempSync(join(tmpdir(), 'helm-loops-'));
    const file = join(dir, 'unbounded.yaml');
    writeFileSync(
      file,
      [
        'name: unbounded',
        'trigger: { type: cron, every: 5m }',
        'bounds:',
        '  max_iterations_per_day: 10',
        '  budget_per_run_usd: 0.1',
        'steps:',
        '  - agent: argus',
        '    do: run forever',
        'exit: [clean]',
      ].join('\n'),
      'utf8',
    );

    const res = h.loops.registry.registerFile(file);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path.includes('budget_per_day_usd'))).toBe(true);
    }
    expect(h.loops.registry.get('unbounded')).toBeNull();
  });

  it('rejects a YAML with no exit condition', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const dir = mkdtempSync(join(tmpdir(), 'helm-loops-'));
    const file = join(dir, 'no-exit.yaml');
    writeFileSync(
      file,
      [
        'name: no-exit',
        'trigger: { type: manual }',
        'bounds: { max_iterations_per_day: 1, budget_per_run_usd: 0.1, budget_per_day_usd: 0.2 }',
        'steps: [{ agent: argus, do: something }]',
        'exit: []',
      ].join('\n'),
      'utf8',
    );

    const res = h.loops.registry.registerFile(file);
    expect(res.ok).toBe(false);
  });
});

describe('Phase 8 — portability and billing', () => {
  it('a loop runs on the subscription unless it explicitly asks otherwise', async () => {
    const runner = new FakeRunner(async () => okResult({ finalText: output({ novel: 0 }) }));
    const h = harness(runner);
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'default-billing', steps: [WATCHDOG.steps[0]] });

    await h.loops.engine.run(loopId, 'test');
    expect(runner.specs[0]!.billing).toBe('subscription');
  });

  it('honours a per-loop billing override for overnight work', async () => {
    const runner = new FakeRunner(async () => okResult({ finalText: output({ novel: 0 }) }));
    const h = harness(runner);
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({
      ...WATCHDOG,
      name: 'overnight',
      billing: 'api',
      steps: [WATCHDOG.steps[0]],
    });

    await h.loops.engine.run(loopId, 'test');
    expect(runner.specs[0]!.billing).toBe('api');
  });
});

describe('the health watchdog (no LLM in this path)', () => {
  it('parks a loop that keeps rediscovering the same finding', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'thrasher', steps: [WATCHDOG.steps[0]] });

    const trace = JSON.stringify([
      { index: 0, agent: 'argus', ran: true, output: { signature: 'build-red', novel: 1 } },
    ]);
    for (let i = 0; i < 3; i++) {
      h.db
        .insert(loopRuns)
        .values({
          id: `run_${i}`,
          loopId,
          startedAt: Date.now() - (i + 1) * 60_000,
          endedAt: Date.now() - (i + 1) * 60_000 + 5_000,
          outcome: 'clean',
          stepsTraceJson: trace,
          costUsd: 0.02,
        })
        .run();
    }

    const parked = h.loops.watchdog.sweep();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.reason).toMatch(/same finding/);
    expect(h.loops.registry.get(loopId)!.status).toBe('parked');
  });

  it('does not call it thrash when one of those runs actually resolved it', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'recurring', steps: [WATCHDOG.steps[0]] });

    const trace = JSON.stringify([
      { index: 0, agent: 'argus', ran: true, output: { signature: 'build-red', novel: 1 } },
    ]);
    // Same signal three times, but the middle run fixed it — the signal came
    // back afterwards, which is a regression, not a loop spinning in place.
    ['clean', 'fix-verified', 'clean'].forEach((outcome, i) => {
      h.db
        .insert(loopRuns)
        .values({
          id: `rec_${i}`,
          loopId,
          startedAt: Date.now() - (i + 1) * 60_000,
          endedAt: Date.now() - (i + 1) * 60_000 + 5_000,
          outcome,
          stepsTraceJson: trace,
          costUsd: 0.02,
        })
        .run();
    });

    expect(h.loops.watchdog.sweep()).toHaveLength(0);
    expect(h.loops.registry.get(loopId)!.status).toBe('enabled');
  });

  it('parks a loop whose latest run cost multiples of its norm', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'spender', steps: [WATCHDOG.steps[0]] });

    const costs = [2.0, 0.02, 0.02, 0.03];
    costs.forEach((cost, i) => {
      h.db
        .insert(loopRuns)
        .values({
          id: `spend_${i}`,
          loopId,
          startedAt: Date.now() - i * 60_000,
          endedAt: Date.now() - i * 60_000 + 1_000,
          outcome: 'clean',
          stepsTraceJson: JSON.stringify([
            { index: 0, agent: 'argus', ran: true, output: { n: i } },
          ]),
          costUsd: cost,
        })
        .run();
    });

    const parked = h.loops.watchdog.sweep();
    expect(parked[0]!.reason).toMatch(/3×/);
  });

  it('parks a run that has been going far longer than usual', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'stuck', steps: [WATCHDOG.steps[0]] });
    const now = Date.now();

    h.db
      .insert(loopRuns)
      .values({ id: 'stuck_live', loopId, startedAt: now - 40 * 60_000, stepsTraceJson: '[]', costUsd: 0 })
      .run();

    const parked = h.loops.watchdog.sweep(now);
    expect(parked[0]!.reason).toMatch(/over 2×/);
  });

  it('does not call waiting-for-a-human "stuck"', () => {
    const h = harness(new FakeRunner(async () => okResult()));
    h.addAgent(h.addProject(), { name: 'argus' });
    const loopId = h.loops.add({ ...WATCHDOG, name: 'patient', steps: [WATCHDOG.steps[0]] });
    const now = Date.now();

    h.db
      .insert(loopRuns)
      .values({
        id: 'patient_live',
        loopId,
        startedAt: now - 20 * 3_600_000,
        stepsTraceJson: '[]',
        costUsd: 0,
        waitingGateId: 'gat_whatever',
      })
      .run();

    expect(h.loops.watchdog.sweep(now)).toHaveLength(0);
    expect(h.loops.registry.get(loopId)!.status).toBe('enabled');
  });
});

describe('loop plumbing', () => {
  it('reads the OUTPUT block, and falls back to the report line without one', () => {
    expect(parseStepOutput('x\n## OUTPUT\n```json\n{"novel":3}\n```')).toEqual({ novel: 3 });
    expect(parseStepOutput('CLEAN: nothing to do.')).toMatchObject({ clean: true, novel: 0 });
    expect(parseStepOutput('FINDING: something.')).toMatchObject({ clean: false, novel: 1 });
  });

  it('fingerprints a run by what it found', () => {
    const a = JSON.stringify([{ index: 0, ran: true, output: { b: 1, a: 2 } }]);
    const b = JSON.stringify([{ index: 0, ran: true, output: { a: 2, b: 1 } }]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  it('knows when a cron loop is due', () => {
    const base = {
      id: 'l',
      name: 'l',
      filePath: null,
      status: 'enabled' as const,
      iterationsToday: 0,
      spendTodayUsd: 0,
      lastOutcome: null,
      parkedReason: null,
    };
    const def = { ...WATCHDOG, memory: true } as never;
    const now = Date.now();

    expect(isCronDue({ ...base, definition: def, lastRunAt: now - 16 * 60_000 }, now)).toBe(true);
    expect(isCronDue({ ...base, definition: def, lastRunAt: now - 60_000 }, now)).toBe(false);
    expect(isCronDue({ ...base, definition: def, lastRunAt: null }, now)).toBe(true);
  });

  it('fires an event-triggered loop when another loop emits its event', async () => {
    const ran: string[] = [];
    const runner = new FakeRunner(async (spec) => {
      ran.push(spec.agentName);
      return okResult({ finalText: output({ novel: 0 }) });
    });
    const h = harness(runner);
    h.addAgent(h.addProject(), { name: 'argus' });

    h.loops.add({
      name: 'on-finding',
      trigger: { type: 'event', on: 'finding' },
      bounds: { max_iterations_per_day: 5, budget_per_run_usd: 0.1, budget_per_day_usd: 0.5 },
      steps: [{ agent: 'argus', do: 'react to the finding' }],
      exit: ['clean'],
    });

    h.loops.scheduler.onEvent('finding');
    await vi.waitFor(() => expect(ran).toContain('argus'));
  });
});
