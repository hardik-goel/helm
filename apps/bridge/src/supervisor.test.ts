import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { agents, gateItems, pulses, sessions, spendDaily } from './db/schema.js';
import { FakeRunner, makeHarness, okResult, type Harness } from './test-harness.js';
import { AuthRequiredError } from './runner/types.js';
import { readTranscript } from './transcripts.js';

const open: Harness[] = [];
function harness(runner: FakeRunner, opts?: { maxConcurrent?: number }) {
  const h = makeHarness(runner, opts);
  open.push(h);
  return h;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('Phase 1 — running one agent', () => {
  it('writes a session row with real cost and turns, and saves a transcript', async () => {
    const runner = new FakeRunner(async (spec) => {
      spec.onMessage({ role: 'system', text: 'session init' });
      spec.onMessage({ role: 'assistant', text: 'looking around' });
      return okResult({ costUsd: 0.0431, turns: 5 });
    });
    const h = harness(runner);
    const p = h.addProject();
    const a = h.addAgent(p);

    const outcome = await h.sup.request({ agentId: a, trigger: 'manual' });

    const row = h.db.select().from(sessions).where(eq(sessions.id, outcome.sessionId)).get()!;
    expect(row.exitReason).toBe('completed');
    expect(row.costUsd).toBeCloseTo(0.0431, 4);
    expect(row.turns).toBe(5);
    expect(row.endedAt).toBeGreaterThan(0);
    expect(row.claudeSessionId).toBe('claude-session-1');
    expect(existsSync(row.transcriptPath!)).toBe(true);
    expect(readFileSync(row.transcriptPath!, 'utf8')).toContain('looking around');
  });

  it('records the raw message stream so an agent’s claims can be audited', async () => {
    const runner = new FakeRunner(async (spec) => {
      spec.onRaw?.({ type: 'user', content: 'a system reminder the agent will later cite' });
      spec.onMessage({ role: 'assistant', text: 'I was told something odd' });
      return okResult();
    });
    const h = harness(runner);
    const outcome = await h.sup.request({ agentId: h.addAgent(h.addProject()), trigger: 'manual' });

    const path = h.db.select().from(sessions).where(eq(sessions.id, outcome.sessionId)).get()!
      .transcriptPath!;
    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('a system reminder the agent will later cite');
    expect(contents).toContain('"kind":"raw"');

    // The drawer view hides the raw lines; the audit view keeps them.
    expect(JSON.stringify(readTranscript(outcome.sessionId))).not.toContain('"kind":"raw"');
    expect(JSON.stringify(readTranscript(outcome.sessionId, 2000, true))).toContain('"kind":"raw"');
  });

  it('streams every message over the websocket hub', async () => {
    const runner = new FakeRunner(async (spec) => {
      spec.onMessage({ role: 'assistant', text: 'one' });
      spec.onMessage({ role: 'tool', text: 'two' });
      return okResult();
    });
    const h = harness(runner);
    const seen: string[] = [];
    vi.spyOn(h.rt.hub, 'broadcast').mockImplementation((m) => {
      if (m.type === 'session.stream') seen.push(m.text);
    });

    const p = h.addProject();
    await h.sup.request({ agentId: h.addAgent(p), trigger: 'manual' });
    expect(seen).toEqual(['one', 'two']);
  });

  it('runs in the project cwd with HELM.md appended and the read-only allowlist', async () => {
    const runner = new FakeRunner(async () => okResult());
    const h = harness(runner);
    const p = h.addProject('trinetra');
    await h.sup.request({ agentId: h.addAgent(p), trigger: 'manual' });

    const spec = runner.specs[0]!;
    expect(spec.cwd).toBe(h.workspace);
    expect(spec.allowlist).toEqual(['Read', 'Grep', 'Glob']);
    expect(spec.systemPromptAppend).toContain('HELM PROTOCOL');
  });

  it('records spend against the agent for today', async () => {
    const runner = new FakeRunner(async () => okResult({ costUsd: 0.25 }));
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    await h.sup.request({ agentId: a, trigger: 'manual' });

    const spend = h.db.select().from(spendDaily).where(eq(spendDaily.agentId, a)).get()!;
    expect(spend.costUsd).toBeCloseTo(0.25, 4);
  });

  it('resumes the previous Claude session so heartbeats share memory', async () => {
    const runner = new FakeRunner(async () => okResult({ claudeSessionId: 'cs-42' }));
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    await h.sup.request({ agentId: a, trigger: 'manual' });
    await h.sup.request({ agentId: a, trigger: 'heartbeat' });

    expect(runner.specs[0]!.resumeSessionId).toBeNull();
    expect(runner.specs[1]!.resumeSessionId).toBe('cs-42');
  });

  it('surfaces a claude login banner on auth failure and never asks for a key', async () => {
    const runner = new FakeRunner(async () => {
      throw new AuthRequiredError('Invalid API key · Please run /login');
    });
    const h = harness(runner);
    const messages: string[] = [];
    vi.spyOn(h.rt.hub, 'broadcast').mockImplementation((m) => {
      if (m.type === 'feed.event') messages.push(m.event.message);
    });

    const a = h.addAgent(h.addProject());
    await expect(h.sup.request({ agentId: a, trigger: 'manual' })).rejects.toThrow();

    const banner = messages.find((m) => m.includes('AUTH REQUIRED'));
    expect(banner).toBeDefined();
    expect(banner).toContain('claude login');
    expect(messages.join(' ')).not.toMatch(/api[_ ]key/i);
    expect(h.rt.authOk).toBe(false);
  });

  it('passes the agent’s autonomy and child budget to the permission callback', async () => {
    const runner = new FakeRunner(async () => okResult());
    const h = harness(runner);
    const a = h.addAgent(h.addProject(), { autonomy: 2, maxChildren: 3 });
    await h.sup.request({ agentId: a, trigger: 'manual' });

    expect(runner.specs[0]!.autonomy).toBe(2);
    expect(runner.specs[0]!.maxChildren).toBe(3);
  });

  it('does not finalize a killed session twice, so its cost is counted once', async () => {
    const runner = new FakeRunner(
      async (spec) =>
        new Promise((resolve) => {
          // Ignores the abort for a while, the way a wedged child would.
          spec.signal.addEventListener('abort', () => {
            setTimeout(() => resolve(okResult({ costUsd: 0.5, turns: 1 })), 2100);
          });
        }),
    );
    const h = harness(runner);
    const a = h.addAgent(h.addProject(), { dailyCapUsd: 100 });
    const run = h.sup.request({ agentId: a, trigger: 'manual' });
    await vi.waitFor(() => expect(h.sup.running()).toBe(1));

    await h.sup.killAll('test');
    await Promise.allSettled([run]);
    await new Promise((r) => setTimeout(r, 2300));

    const spend = h.db.select().from(spendDaily).where(eq(spendDaily.agentId, a)).get();
    expect(spend?.costUsd ?? 0).toBe(0);
    expect(h.db.select().from(sessions).where(eq(sessions.agentId, a)).all()).toHaveLength(1);
  });

  it('never leaks ANTHROPIC_API_KEY into a subscription session', async () => {
    const runner = new FakeRunner(async () => okResult());
    const h = harness(runner);
    await h.sup.request({ agentId: h.addAgent(h.addProject()), trigger: 'manual' });
    expect(runner.specs[0]!.billing).toBe('subscription');
    expect(runner.specs[0]!.apiKey).toBeNull();
  });
});

describe('Law 6 — silence is a bug', () => {
  it('writes a pulse row on a clean heartbeat', async () => {
    const runner = new FakeRunner(async () => okResult({ finalText: 'CLEAN: nothing moved.' }));
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    await h.sup.request({ agentId: a, trigger: 'heartbeat' });

    const rows = h.db.select().from(pulses).where(eq(pulses.agentId, a)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clean).toBe(true);
    expect(rows[0]!.finding).toBe('nothing moved.');
  });

  it('writes a non-clean pulse row when the agent reports a finding', async () => {
    const runner = new FakeRunner(async () =>
      okResult({ finalText: 'FINDING: the build has been red for 3 hours.' }),
    );
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    await h.sup.request({ agentId: a, trigger: 'heartbeat' });

    const row = h.db.select().from(pulses).where(eq(pulses.agentId, a)).get()!;
    expect(row.clean).toBe(false);
    expect(row.finding).toContain('red for 3 hours');
  });

  it('treats an empty report as a failed pulse rather than skipping the row', async () => {
    const runner = new FakeRunner(async () => okResult({ finalText: '' }));
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    await h.sup.request({ agentId: a, trigger: 'heartbeat' });

    const row = h.db.select().from(pulses).where(eq(pulses.agentId, a)).get()!;
    expect(row.clean).toBe(false);
    expect(row.finding).toContain('silence is a bug');
  });
});

describe('Law 4 — spend ceiling', () => {
  it('parks an agent that has reached its daily cap and refuses to wake it', async () => {
    const runner = new FakeRunner(async () => okResult({ costUsd: 3 }));
    const h = harness(runner);
    const a = h.addAgent(h.addProject(), { dailyCapUsd: 1 });

    await h.sup.request({ agentId: a, trigger: 'manual' });
    expect(h.db.select().from(agents).where(eq(agents.id, a)).get()!.status).toBe('parked-cap');

    await expect(h.sup.request({ agentId: a, trigger: 'heartbeat' })).rejects.toThrow(
      /daily spend cap/,
    );
  });

  it('refuses every agent once the fleet cap is reached', async () => {
    const runner = new FakeRunner(async () => okResult({ costUsd: 30 }));
    const h = harness(runner);
    const p = h.addProject();
    const a = h.addAgent(p, { dailyCapUsd: 100 });
    const b = h.addAgent(p, { name: 'vesta', dailyCapUsd: 100 });

    await h.sup.request({ agentId: a, trigger: 'manual' });
    await expect(h.sup.request({ agentId: b, trigger: 'manual' })).rejects.toThrow(/fleet daily/);
  });
});

describe('Law 5 — concurrency governor', () => {
  it('queues beyond the cap and orders the queue by project sort order', async () => {
    const release: Array<() => void> = [];
    const started: string[] = [];
    const runner = new FakeRunner(async (spec) => {
      started.push(spec.agentName);
      await new Promise<void>((r) => release.push(r));
      return okResult();
    });
    const h = harness(runner, { maxConcurrent: 1 });

    const first = h.addProject('first');
    const second = h.addProject('second');
    const third = h.addProject('third');
    const a = h.addAgent(first, { name: 'a' });
    const b = h.addAgent(third, { name: 'b' });
    const c = h.addAgent(second, { name: 'c' });

    const pa = h.sup.request({ agentId: a, trigger: 'manual' });
    const pb = h.sup.request({ agentId: b, trigger: 'manual' });
    const pc = h.sup.request({ agentId: c, trigger: 'manual' });

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(h.sup.running()).toBe(1);
    expect(h.sup.queued()).toHaveLength(2);

    release.shift()!();
    await pa;
    await vi.waitFor(() => expect(started).toHaveLength(2));
    // 'c' sits on the higher project in the tree, so it wakes before 'b'.
    expect(started[1]).toBe('c');

    release.forEach((r) => r());
    release.length = 0;
    await vi.waitFor(async () => {
      release.forEach((r) => r());
      await Promise.resolve();
      expect(started).toHaveLength(3);
    });
    await Promise.allSettled([pb, pc]);
  });

  it('refuses to double-wake an agent that is already live', async () => {
    const hold: Array<() => void> = [];
    const runner = new FakeRunner(async () => {
      await new Promise<void>((r) => hold.push(r));
      return okResult();
    });
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    const p1 = h.sup.request({ agentId: a, trigger: 'manual' });
    await expect(h.sup.request({ agentId: a, trigger: 'manual' })).rejects.toThrow(/already has/);
    await vi.waitFor(() => expect(hold).toHaveLength(1));
    hold[0]!();
    await p1;
  });
});

describe('Law 3 — kill switch', () => {
  it('aborts live sessions in under two seconds and pauses every agent', async () => {
    const runner = new FakeRunner(
      async (spec) =>
        new Promise((resolve) => {
          spec.signal.addEventListener('abort', () =>
            resolve(okResult({ exitReason: 'killed', costUsd: 0, turns: 0 })),
          );
        }),
    );
    const h = harness(runner, { maxConcurrent: 3 });
    const p = h.addProject();
    const a = h.addAgent(p, { name: 'a' });
    const b = h.addAgent(p, { name: 'b' });

    const pa = h.sup.request({ agentId: a, trigger: 'manual' });
    const pb = h.sup.request({ agentId: b, trigger: 'manual' });
    await vi.waitFor(() => expect(h.sup.running()).toBe(2));

    const t0 = Date.now();
    await h.sup.killAll('test');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(h.sup.running()).toBe(0);
    for (const id of [a, b]) {
      expect(h.db.select().from(agents).where(eq(agents.id, id)).get()!.status).toBe('paused');
    }
    await Promise.allSettled([pa, pb]);
  });

  it('refuses to start anything while the fleet is killed', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    h.rt.setKilled(true, 'test');
    await expect(h.sup.request({ agentId: a, trigger: 'manual' })).rejects.toThrow(/killed/);
  });

  it('comes back killed after a restart, and clears orphaned sessions', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    h.rt.setKilled(true, 'test');
    h.db
      .insert(sessions)
      .values({ id: 'ses_orphan', agentId: a, startedAt: Date.now(), costUsd: 0, turns: 0 })
      .run();

    h.sup.reconcileOnBoot();

    expect(h.rt.isKilled()).toBe(true);
    expect(h.db.select().from(sessions).where(eq(sessions.id, 'ses_orphan')).get()!.exitReason).toBe(
      'killed',
    );
    expect(h.db.select().from(agents).where(eq(agents.id, a)).get()!.status).toBe('paused');
  });
});

describe('Law 1 — nothing irreversible without a human-approved row', () => {
  it('blocks the session at the gate and resumes it on approval', async () => {
    let decision: string | null = null;
    const runner = new FakeRunner(async (spec) => {
      const d = await spec.onPermission({
        toolName: 'Bash',
        input: { command: 'git push origin main' },
        kind: 'push',
        reason: 'irreversible command',
      });
      decision = d.behavior;
      return okResult();
    });
    const h = harness(runner);
    const a = h.addAgent(h.addProject());

    const run = h.sup.request({ agentId: a, trigger: 'manual' });

    await vi.waitFor(() => expect(h.gate.listPending()).toHaveLength(1));
    const item = h.gate.listPending()[0]!;
    expect(item.kind).toBe('push');
    expect(decision).toBeNull(); // still blocked
    expect(h.db.select().from(agents).where(eq(agents.id, a)).get()!.status).toBe('waiting-gate');

    h.gate.decide(item.id, 'approved');
    await run;
    expect(decision).toBe('allow');

    const row = h.db.select().from(gateItems).where(eq(gateItems.id, item.id)).get()!;
    expect(row.decidedBy).toBe('human');
    expect(row.decision).toBe('approved');
  });

  it('tells the agent to hold when a proposal is denied, and logs it', async () => {
    let denialMessage = '';
    const runner = new FakeRunner(async (spec) => {
      const d = await spec.onPermission({
        toolName: 'Bash',
        input: { command: 'git push origin main' },
        kind: 'push',
        reason: 'irreversible command',
      });
      if (d.behavior === 'deny') denialMessage = d.message;
      return okResult();
    });
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    const run = h.sup.request({ agentId: a, trigger: 'manual' });

    await vi.waitFor(() => expect(h.gate.listPending()).toHaveLength(1));
    h.gate.decide(h.gate.listPending()[0]!.id, 'denied');
    await run;

    expect(denialMessage).toMatch(/DENIED/);
    expect(denialMessage).toMatch(/do not route around it/);
  });

  it('turns a PROPOSED ACTIONS block into gate items regardless of runner path', async () => {
    const runner = new FakeRunner(async () =>
      okResult({
        finalText: [
          'FINDING: the README install step is wrong.',
          '',
          '## PROPOSED ACTIONS',
          '```json',
          '{"actions":[{"kind":"push","label":"push README fix","detail":"one line","payload":{"command":"git push origin main"}}]}',
          '```',
        ].join('\n'),
      }),
    );
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    const outcome = await h.sup.request({ agentId: a, trigger: 'manual' });

    expect(outcome.gateItemIds).toHaveLength(1);
    const row = h.db.select().from(gateItems).where(eq(gateItems.id, outcome.gateItemIds[0]!)).get()!;
    expect(row.kind).toBe('push');
    expect(row.status).toBe('pending');
    expect(row.source).toBe('proposed-actions');
  });

  it('REFUSES to execute a payload that is not human-approved', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());

    const item = h.gate.create({
      agentId: a,
      kind: 'push',
      label: 'push',
      payload: { command: 'touch SHOULD_NOT_EXIST' },
      source: 'proposed-actions',
    });

    const pending = await h.gate.execute(item.id, h.workspace);
    expect(pending.ok).toBe(false);
    expect(pending.output).toMatch(/REFUSED/);

    // Forge the row the way a compromised agent would: approved, but by 'system'.
    h.db
      .update(gateItems)
      .set({ status: 'approved', decision: 'approved', decidedBy: 'system', decidedAt: Date.now() })
      .where(eq(gateItems.id, item.id))
      .run();

    const forged = await h.gate.execute(item.id, h.workspace);
    expect(forged.ok).toBe(false);
    expect(forged.output).toMatch(/REFUSED/);
    expect(existsSync(`${h.workspace}/SHOULD_NOT_EXIST`)).toBe(false);
  });

  it('executes exactly once after a human approves, and refuses a replay', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    const item = h.gate.create({
      agentId: a,
      kind: 'write',
      label: 'touch marker',
      payload: { command: 'touch APPROVED_MARKER' },
      source: 'proposed-actions',
    });

    h.gate.decide(item.id, 'approved');
    const first = await h.gate.execute(item.id, h.workspace);
    expect(first.ok).toBe(true);
    expect(existsSync(`${h.workspace}/APPROVED_MARKER`)).toBe(true);

    const replay = await h.gate.execute(item.id, h.workspace);
    expect(replay.ok).toBe(false);
    expect(replay.output).toMatch(/single-use/);
  });

  it('applies an approved file proposal inside the workspace', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    writeFileSync(`${h.workspace}/README.md`, 'Install: run `npm install`\n');

    const item = h.gate.create({
      agentId: a,
      kind: 'write',
      label: 'fix install command',
      payload: { file: 'README.md', old: 'npm install', new: 'pnpm install' },
      source: 'proposed-actions',
    });
    h.gate.decide(item.id, 'approved');

    const res = await h.gate.execute(item.id, h.workspace);
    expect(res.ok).toBe(true);
    expect(readFileSync(`${h.workspace}/README.md`, 'utf8')).toContain('pnpm install');
  });

  it('refuses a file proposal that points outside the workspace', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    const item = h.gate.create({
      agentId: a,
      kind: 'write',
      label: 'escape',
      payload: { file: '../../etc/helm-should-not-exist', content: 'x' },
      source: 'proposed-actions',
    });
    h.gate.decide(item.id, 'approved');

    const res = await h.gate.execute(item.id, h.workspace);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/REFUSED/);
  });

  it('refuses an ambiguous replacement rather than guessing', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    writeFileSync(`${h.workspace}/dup.txt`, 'x\nx\n');
    const item = h.gate.create({
      agentId: a,
      kind: 'write',
      label: 'ambiguous',
      payload: { file: 'dup.txt', old: 'x', new: 'y' },
      source: 'proposed-actions',
    });
    h.gate.decide(item.id, 'approved');

    const res = await h.gate.execute(item.id, h.workspace);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/ambiguous/);
    expect(readFileSync(`${h.workspace}/dup.txt`, 'utf8')).toBe('x\nx\n');
  });

  it('reports an approved proposal that carried nothing runnable', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    const item = h.gate.create({
      agentId: a,
      kind: 'other',
      label: 'vague idea',
      payload: { thoughts: 'we should refactor' },
      source: 'proposed-actions',
    });
    h.gate.decide(item.id, 'approved');

    const res = await h.gate.execute(item.id, h.workspace);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/nothing the bridge can execute/);
  });

  it('does not try to run a permission-callback item on the bridge', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    const item = h.gate.create({
      agentId: a,
      kind: 'push',
      label: 'Bash: git push origin main',
      payload: { tool: 'Bash', input: { command: 'git push origin main' }, cwd: h.workspace },
      source: 'permission-callback',
    });
    h.gate.decide(item.id, 'approved');

    const res = await h.gate.execute(item.id, h.workspace);
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/released to the waiting session/);
  });

  it('cannot be decided twice', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    const item = h.gate.create({ agentId: a, kind: 'other', label: 'x' });
    expect(h.gate.decide(item.id, 'approved')).not.toBeNull();
    expect(h.gate.decide(item.id, 'denied')).toBeNull();
  });

  it('releases a held approval when its session ends, instead of stranding it', async () => {
    let decided: string | null = null;
    const runner = new FakeRunner(async (spec) => {
      const d = await spec.onPermission({
        toolName: 'Bash',
        input: { command: 'git push origin main' },
        kind: 'push',
        reason: 'irreversible command',
      });
      decided = d.behavior;
      return okResult();
    });
    const h = harness(runner);
    const a = h.addAgent(h.addProject());
    const run = h.sup.request({ agentId: a, trigger: 'manual' });

    await vi.waitFor(() => expect(h.gate.listPending()).toHaveLength(1));
    await h.sup.killAll('test');
    await Promise.allSettled([run]);

    expect(h.gate.listPending()).toHaveLength(0);
    expect(decided).toBe('deny');
  });

  it('expires a permission-callback item whose session died with the bridge', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    const item = h.gate.create({
      agentId: a,
      kind: 'push',
      label: 'stale',
      source: 'permission-callback',
    });

    h.gate.reapOrphansOnBoot();
    expect(h.gate.get(item.id)!.status).toBe('expired');
    expect(h.gate.isHumanApproved(item.id)).toBe(false);
  });

  it('keeps a proposed-actions item pending across a bridge restart', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const a = h.addAgent(h.addProject());
    const item = h.gate.create({
      agentId: a,
      kind: 'push',
      label: 'still yours to decide',
      payload: { command: 'true' },
      source: 'proposed-actions',
    });

    h.gate.reapOrphansOnBoot();
    expect(h.gate.get(item.id)!.status).toBe('pending');
  });
});
