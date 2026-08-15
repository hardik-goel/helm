import { describe, expect, it } from 'vitest';
import { ServerMessage } from './ws.js';
import { HelmConfig } from './config.js';

describe('ServerMessage', () => {
  it('round-trips a session stream chunk', () => {
    const msg = {
      type: 'session.stream',
      sessionId: 'ses_1',
      agentId: 'agt_1',
      seq: 3,
      role: 'assistant',
      text: 'hello',
      at: 1,
    };
    expect(ServerMessage.parse(msg)).toMatchObject({ type: 'session.stream' });
  });

  it('rejects an unknown message type', () => {
    expect(ServerMessage.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('rejects a chunk with an unknown role', () => {
    const bad = {
      type: 'session.stream',
      sessionId: 's',
      agentId: 'a',
      seq: 0,
      role: 'wizard',
      text: '',
      at: 0,
    };
    expect(ServerMessage.safeParse(bad).success).toBe(false);
  });
});

describe('HelmConfig', () => {
  it('fills governor defaults', () => {
    const c = HelmConfig.parse({});
    expect(c.governor.maxConcurrent).toBe(3);
    expect(c.governor.consolePort).toBe(3777);
    expect(c.governor.bridgePort).toBe(8787);
  });

  it('defaults an agent to subscription billing and a read-only allowlist', () => {
    const c = HelmConfig.parse({
      projects: [{ id: 'p', name: 'p', path: '/tmp/p' }],
      agents: [{ id: 'a', projectId: 'p', name: 'argus' }],
    });
    expect(c.agents[0]!.billing).toBe('subscription');
    expect(c.agents[0]!.allowlist).toEqual(['Read', 'Grep', 'Glob']);
  });
});
