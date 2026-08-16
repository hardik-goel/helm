import { describe, expect, it } from 'vitest';
import { evaluateGuard } from './expr.js';

const scope = {
  findings: { novel: 2, list: ['a'], none: [] },
  diagnosis: { fixable: true, severity: 'high' },
  gate: { approved: true },
  count: 0,
};

describe('loop guards', () => {
  it('an absent guard always runs the step', () => {
    expect(evaluateGuard(undefined, scope).value).toBe(true);
    expect(evaluateGuard('   ', scope).value).toBe(true);
  });

  it.each([
    ['findings.novel > 0', true],
    ['findings.novel > 5', false],
    ['diagnosis.fixable', true],
    ['gate.approved', true],
    ['count > 0', false],
    ['findings.list', true],
    ['findings.none', false],
    ['diagnosis.severity == "high"', true],
    ['diagnosis.severity != "high"', false],
    ['findings.novel > 0 && diagnosis.fixable', true],
    ['findings.novel > 9 || diagnosis.fixable', true],
    ['!diagnosis.fixable', false],
    ['(findings.novel > 0) && !gate.approved', false],
  ])('evaluates %s', (expr, expected) => {
    expect(evaluateGuard(expr, scope).value).toBe(expected);
  });

  it('treats an unknown path as false rather than throwing', () => {
    expect(evaluateGuard('nothing.here > 0', scope).value).toBe(false);
  });

  it('refuses to run a step whose guard cannot be parsed', () => {
    const r = evaluateGuard('findings.novel >', scope);
    expect(r.value).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('cannot reach the host — a guard is not JavaScript', () => {
    const r = evaluateGuard('process.exit(1)', scope);
    expect(r.value).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('cannot call a function even when one is in scope', () => {
    const r = evaluateGuard('boom()', { boom: () => true });
    expect(r.value).toBe(false);
  });
});
