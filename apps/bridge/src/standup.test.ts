import { afterEach, describe, expect, it } from 'vitest';
import { buildStandup, standupToMarkdown } from './standup.js';
import { FakeRunner, makeHarness, okResult, type Harness } from './test-harness.js';

const open: Harness[] = [];
function harness(): Harness & { runner: FakeRunner } {
  const runner = new FakeRunner(async () => okResult());
  const h = makeHarness(runner);
  open.push(h);
  return Object.assign(h, { runner });
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('Phase 6 — standup digest', () => {
  it('reports what moved, what is blocked, and what waits on the human', async () => {
    const h = harness();
    const p = h.addProject('trinetra');
    const a = h.addAgent(p, { name: 'argus' });

    await h.sup.request({ agentId: a, trigger: 'heartbeat' }); // clean pulse
    h.gate.create({ agentId: a, kind: 'push', label: 'push the fix', source: 'proposed-actions' });
    const denied = h.gate.create({ agentId: a, kind: 'deploy', label: 'deploy to prod' });
    h.gate.decide(denied.id, 'denied');

    const d = buildStandup(h.db, 24);
    const proj = d.projects.find((x) => x.projectId === p)!;

    expect(proj.sessions).toBe(1);
    expect(proj.cleanPulses).toBe(1);
    expect(proj.waiting.some((w) => w.includes('push the fix'))).toBe(true);
    expect(proj.blocked.some((b) => b.includes('deploy to prod'))).toBe(true);
    expect(d.totalCostUsd).toBeGreaterThan(0);
  });

  it('surfaces a finding as something that moved', async () => {
    const h = harness();
    const p = h.addProject('vega');
    const a = h.addAgent(p, { name: 'vesta' });
    h.runner.setScript(async () => okResult({ finalText: 'FINDING: build is red.' }));
    await h.sup.request({ agentId: a, trigger: 'heartbeat', prompt: 'x' });

    const d = buildStandup(h.db, 24);
    const proj = d.projects.find((x) => x.projectId === p)!;
    expect(proj.findings).toBe(1);
    expect(proj.moved.some((m) => m.includes('build is red'))).toBe(true);
  });

  it('keeps an old pending approval visible even outside the window', () => {
    const h = harness();
    const p = h.addProject('old');
    const a = h.addAgent(p);
    h.gate.create({ agentId: a, kind: 'publish', label: 'ancient request' });

    // A one-hour window would normally exclude it; pending items are exempt.
    const d = buildStandup(h.db, 1, Date.now() + 48 * 3_600_000);
    const proj = d.projects.find((x) => x.projectId === p)!;
    expect(proj.waiting.some((w) => w.includes('ancient request'))).toBe(true);
  });

  it('renders markdown a human can paste into a channel', async () => {
    const h = harness();
    const a = h.addAgent(h.addProject('trinetra'));
    await h.sup.request({ agentId: a, trigger: 'heartbeat' });

    const md = standupToMarkdown(buildStandup(h.db, 24));
    expect(md).toContain('# Helm standup — last 24h');
    expect(md).toContain('## trinetra');
    expect(md).toContain('**Waiting on you.**');
  });

  it('says so plainly when nothing ran', () => {
    const h = harness();
    h.addProject('quiet');
    expect(standupToMarkdown(buildStandup(h.db, 24))).toContain('Nothing ran in this window.');
  });
});
