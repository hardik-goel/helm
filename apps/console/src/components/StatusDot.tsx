'use client';

import type { AgentStatus } from '@helm/core';

const CLASS: Record<AgentStatus, string> = {
  idle: 'dot',
  running: 'dot live',
  queued: 'dot wait',
  'waiting-gate': 'dot wait',
  paused: 'dot',
  'parked-cap': 'dot err',
  error: 'dot err',
  decommissioned: 'dot',
};

const TITLE: Record<AgentStatus, string> = {
  idle: 'idle',
  running: 'running',
  queued: 'queued — waiting for a governor slot',
  'waiting-gate': 'blocked at the approval gate',
  paused: 'paused',
  'parked-cap': 'parked — daily spend cap reached',
  error: 'error',
  decommissioned: 'decommissioned',
};

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={CLASS[status]} title={TITLE[status]} aria-label={TITLE[status]} />;
}
