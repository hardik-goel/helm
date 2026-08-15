import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferProjectName, LaunchPad, uniqueWorkspace } from './launch.js';
import { FakeRunner, makeHarness, okResult, type Harness } from './test-harness.js';

const open: Harness[] = [];
function harness(runner: FakeRunner) {
  const h = makeHarness(runner);
  open.push(h);
  return h;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('inferProjectName', () => {
  it('names a project from the meaningful words of its brief', () => {
    expect(inferProjectName('Build a CLI that prints the NSE holiday calendar as JSON')).toBe(
      'cli-prints-nse-holiday-calendar',
    );
  });

  it('survives markdown and punctuation', () => {
    expect(inferProjectName('# Build **Helm** — mission control')).toBe('helm-mission-control');
  });

  it('always returns something usable', () => {
    expect(inferProjectName('a the an')).toBe('untitled');
  });
});

describe('uniqueWorkspace', () => {
  it('does not clobber an existing folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'helm-root-'));
    mkdirSync(join(root, 'thing'));
    expect(uniqueWorkspace(root, 'thing')).toBe(join(root, 'thing-2'));
  });
});

describe('Phase 5 — Launch Pad', () => {
  it('provisions a workspace, registers the project at the top, and starts a builder', async () => {
    const runner = new FakeRunner(async () => okResult({ finalText: 'CLEAN: built it.' }));
    const h = harness(runner);
    const root = mkdtempSync(join(tmpdir(), 'helm-launchroot-'));
    h.rt.config.update((d) => {
      d.governor.launchRoot = root;
      return d;
    });
    const existing = h.addProject('older');

    const steps: string[] = [];
    vi.spyOn(h.rt.hub, 'broadcast').mockImplementation((m) => {
      if (m.type === 'launch.step') steps.push(`${m.step}:${m.state}`);
    });

    const pad = new LaunchPad(h.rt, h.sup);
    const result = await pad.launch({
      prompt: 'Build a CLI that prints the NSE holiday calendar as JSON',
    });

    expect(result.name).toBe('cli-prints-nse-holiday-calendar');
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(join(result.path, '.git'))).toBe(true);
    expect(existsSync(join(result.path, 'HELM.md'))).toBe(true);
    expect(readFileSync(join(result.path, 'HELM.md'), 'utf8')).toContain('One-Shot Builder');

    const cfg = h.rt.config.get();
    expect(cfg.projects[0]!.id).toBe(result.projectId);
    expect(cfg.projects[0]!.tag).toBe('new');
    expect(cfg.projects.find((p) => p.id === existing)!.order).toBe(1);

    const agent = cfg.agents.find((a) => a.id === result.agentId)!;
    expect(agent.name).toBe('One-Shot Builder');
    expect(agent.autonomy).toBe(2);
    expect(agent.heartbeatMinutes).toBe(10);
    expect(agent.allowlist).toContain('Write');

    await vi.waitFor(() => expect(runner.specs).toHaveLength(1));
    expect(runner.specs[0]!.prompt).toContain('NSE holiday calendar');
    expect(runner.specs[0]!.prompt).toContain('PROPOSED ACTIONS');
    expect(runner.specs[0]!.cwd).toBe(result.path);

    expect(steps).toEqual(
      expect.arrayContaining([
        'workspace:active',
        'workspace:done',
        'git:done',
        'register:done',
        'protocol:done',
        'session:active',
      ]),
    );
  });

  it('refuses to launch while the fleet is killed', async () => {
    const h = harness(new FakeRunner(async () => okResult()));
    const root = mkdtempSync(join(tmpdir(), 'helm-launchroot-'));
    h.rt.config.update((d) => {
      d.governor.launchRoot = root;
      return d;
    });
    h.rt.setKilled(true, 'test');

    const pad = new LaunchPad(h.rt, h.sup);
    const result = await pad.launch({ prompt: 'Build a thing that does a thing properly' });
    // The workspace is still provisioned; the builder simply never wakes.
    expect(existsSync(result.path)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sup.running()).toBe(0);
  });
});
