import { describe, expect, it } from 'vitest';
import { parseDurationMs, validateLoop } from './loop.js';

const good = {
  name: 'trinetra-watchdog',
  trigger: { type: 'cron', every: '15m' },
  bounds: {
    max_iterations_per_day: 40,
    budget_per_run_usd: 0.25,
    budget_per_day_usd: 3.0,
  },
  memory: true,
  steps: [{ agent: 'argus', do: 'Run the standing scan routine.', output: 'findings' }],
  exit: ['clean', 'budget-exhausted'],
};

describe('validateLoop (Law 8)', () => {
  it('accepts a fully bounded loop', () => {
    const r = validateLoop(good);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['budget_per_day_usd', 'budget_per_day_usd'],
    ['budget_per_run_usd', 'budget_per_run_usd'],
    ['max_iterations_per_day', 'max_iterations_per_day'],
  ])('refuses a loop missing %s', (field) => {
    const bounds = { ...good.bounds } as Record<string, number>;
    delete bounds[field];
    const r = validateLoop({ ...good, bounds });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path.includes(field))).toBe(true);
  });

  it('refuses a loop with no exit conditions', () => {
    const r = validateLoop({ ...good, exit: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/exit condition/);
  });

  it('refuses a per-run budget larger than the per-day budget', () => {
    const r = validateLoop({
      ...good,
      bounds: { ...good.bounds, budget_per_run_usd: 5 },
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a when: referencing an output no earlier step produces', () => {
    const r = validateLoop({
      ...good,
      steps: [
        { agent: 'argus', do: 'scan', output: 'findings' },
        { agent: 'vesta', do: 'fix', when: 'diagnosis.fixable' },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a when: referencing an earlier output', () => {
    const r = validateLoop({
      ...good,
      steps: [
        { agent: 'argus', do: 'scan', output: 'findings' },
        { agent: 'argus', do: 'diagnose', when: 'findings.novel > 0', output: 'diagnosis' },
        { agent: 'vesta', do: 'fix', when: 'diagnosis.fixable', gated: true },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('defaults new loops to disabled', () => {
    const r = validateLoop(good);
    if (r.ok) expect(r.loop.enabled).toBe(false);
  });
});

describe('parseDurationMs', () => {
  it('parses units', () => {
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });
  it('throws on garbage', () => {
    expect(() => parseDurationMs('soon')).toThrow();
  });
});
