import { describe, expect, it } from 'vitest';
import {
  classifyToolUse,
  isInsideWorkspace,
  isReadOnlyBash,
  parseProposedActions,
} from './gate.js';
import { DEFAULT_ALLOWLIST } from './domain.js';

const WS = '/Users/x/dev/demo';
const base = { allowlist: [...DEFAULT_ALLOWLIST], workspacePath: WS };

describe('parseProposedActions', () => {
  it('reads a fenced json block under the heading', () => {
    const msg = [
      'All done.',
      '',
      '## PROPOSED ACTIONS',
      '```json',
      '{"actions":[{"kind":"push","label":"push README tweak","detail":"origin/main"}]}',
      '```',
    ].join('\n');
    const actions = parseProposedActions(msg);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('push');
  });

  it('reads a bare array', () => {
    const msg = '## PROPOSED ACTIONS\n[{"kind":"write","label":"touch file"}]';
    expect(parseProposedActions(msg)[0]!.kind).toBe('write');
  });

  it('returns nothing when the heading is absent', () => {
    expect(parseProposedActions('nothing to report, all clean')).toEqual([]);
  });

  it('returns nothing on malformed json rather than guessing', () => {
    expect(parseProposedActions('## PROPOSED ACTIONS\n{oops')).toEqual([]);
  });
});

describe('isReadOnlyBash', () => {
  it.each(['ls -la', 'git status', 'git log --oneline -5', 'rg foo src/'])(
    'allows %s',
    (cmd) => expect(isReadOnlyBash(cmd)).toBe(true),
  );

  it.each([
    'git push origin main',
    'ls -la && rm -rf /',
    'cat x > /etc/hosts',
    'echo hi | sh',
    'npm install left-pad',
  ])('refuses %s', (cmd) => expect(isReadOnlyBash(cmd)).toBe(false));
});

describe('classifyToolUse', () => {
  it('auto-approves allowlisted read tools', () => {
    const r = classifyToolUse({ ...base, toolName: 'Read', input: { file_path: `${WS}/a.ts` } });
    expect(r.decision).toBe('allow');
  });

  it('gates a git push', () => {
    const r = classifyToolUse({ ...base, toolName: 'Bash', input: { command: 'git push origin main' } });
    expect(r).toMatchObject({ decision: 'gate', kind: 'push' });
  });

  it('gates a deploy', () => {
    const r = classifyToolUse({ ...base, toolName: 'Bash', input: { command: 'vercel --prod' } });
    expect(r).toMatchObject({ decision: 'gate', kind: 'deploy' });
  });

  it('gates an install', () => {
    const r = classifyToolUse({ ...base, toolName: 'Bash', input: { command: 'pnpm add lodash' } });
    expect(r).toMatchObject({ decision: 'gate', kind: 'install' });
  });

  it('gates a write outside the workspace even when Write is allowlisted', () => {
    const r = classifyToolUse({
      toolName: 'Write',
      input: { file_path: '/etc/hosts' },
      allowlist: ['Read', 'Grep', 'Glob', 'Write'],
      workspacePath: WS,
    });
    expect(r).toMatchObject({ decision: 'gate', kind: 'write' });
  });

  it('allows a write inside the workspace when Write is allowlisted and autonomy permits', () => {
    const r = classifyToolUse({
      toolName: 'Write',
      input: { file_path: `${WS}/src/a.ts` },
      allowlist: ['Read', 'Write'],
      workspacePath: WS,
      autonomy: 2,
    });
    expect(r.decision).toBe('allow');
  });

  it.each([0, 1])('gates that same write at autonomy %i', (autonomy) => {
    const r = classifyToolUse({
      toolName: 'Write',
      input: { file_path: `${WS}/src/a.ts` },
      allowlist: ['Read', 'Write'],
      workspacePath: WS,
      autonomy,
    });
    expect(r).toMatchObject({ decision: 'gate', kind: 'write' });
    if (r.decision === 'gate') expect(r.reason).toMatch(/autonomy/);
  });

  it('refuses to spawn a sub-agent when max children is zero', () => {
    const r = classifyToolUse({
      ...base,
      toolName: 'Task',
      input: { prompt: 'go look at something' },
      allowlist: ['Read', 'Grep', 'Glob', 'Task'],
      maxChildren: 0,
    });
    expect(r).toMatchObject({ decision: 'gate' });
    if (r.decision === 'gate') expect(r.reason).toMatch(/max children/);
  });

  it('allows a sub-agent when the operator has budgeted for one', () => {
    const r = classifyToolUse({
      ...base,
      toolName: 'Task',
      input: { prompt: 'go look at something' },
      allowlist: ['Read', 'Grep', 'Glob', 'Task'],
      maxChildren: 2,
    });
    expect(r.decision).toBe('allow');
  });

  it('still requires Task to be allowlisted even with children budgeted', () => {
    const r = classifyToolUse({ ...base, toolName: 'Task', input: {}, maxChildren: 3 });
    expect(r.decision).toBe('gate');
  });

  it('gates network fetches to non-allowlisted domains', () => {
    const r = classifyToolUse({
      ...base,
      toolName: 'WebFetch',
      input: { url: 'https://evil.example/x' },
      allowedDomains: ['docs.anthropic.com'],
    });
    expect(r).toMatchObject({ decision: 'gate', kind: 'send' });
  });

  it('allows allowlisted domains', () => {
    const r = classifyToolUse({
      ...base,
      toolName: 'WebFetch',
      input: { url: 'https://docs.anthropic.com/x' },
      allowedDomains: ['docs.anthropic.com'],
    });
    expect(r.decision).toBe('allow');
  });

  it('gates unknown tools by default', () => {
    const r = classifyToolUse({ ...base, toolName: 'SomeMcpTool', input: {} });
    expect(r.decision).toBe('gate');
  });
});

describe('isInsideWorkspace', () => {
  it('rejects traversal', () => {
    expect(isInsideWorkspace(`${WS}/../../etc/hosts`, WS)).toBe(false);
  });
  it('rejects sibling prefixes', () => {
    expect(isInsideWorkspace('/Users/x/dev/demo-evil/a', WS)).toBe(false);
  });
  it('accepts relative paths', () => {
    expect(isInsideWorkspace('src/a.ts', WS)).toBe(true);
  });
});
