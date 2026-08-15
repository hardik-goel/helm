import { z } from 'zod';

/** Autonomy 0-3. Higher means fewer things need a human, but never zero. */
export const AutonomyLevel = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const AUTONOMY_LABELS: Record<number, string> = {
  0: 'observe',
  1: 'suggest',
  2: 'stage',
  3: 'execute-in-workspace',
};

export const AgentStatus = z.enum([
  'idle',
  'running',
  'queued',
  'waiting-gate',
  'paused',
  'parked-cap',
  'error',
  'decommissioned',
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const GateKind = z.enum([
  'push',
  'deploy',
  'publish',
  'send',
  'write',
  'install',
  'other',
]);
export type GateKind = z.infer<typeof GateKind>;

export const GateStatus = z.enum(['pending', 'approved', 'denied', 'expired']);
export type GateStatus = z.infer<typeof GateStatus>;

/** Law 1: only a human can approve. The column exists so the law is queryable. */
export const DecidedBy = z.enum(['human', 'system']);
export type DecidedBy = z.infer<typeof DecidedBy>;

export const EventLevel = z.enum(['debug', 'info', 'warn', 'error', 'critical']);
export type EventLevel = z.infer<typeof EventLevel>;

export const SessionExitReason = z.enum([
  'completed',
  'max-turns',
  'error',
  'killed',
  'cap-reached',
  'gate-denied',
  'auth-required',
]);
export type SessionExitReason = z.infer<typeof SessionExitReason>;

export const Billing = z.enum(['subscription', 'api']);
export type Billing = z.infer<typeof Billing>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  url: z.string().nullable(),
  tag: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
  archivedAt: z.number().int().nullable(),
});
export type Project = z.infer<typeof Project>;

export const Agent = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  role: z.string(),
  model: z.string(),
  mission: z.string(),
  autonomy: AutonomyLevel,
  heartbeatMinutes: z.number().int().min(0),
  maxChildren: z.number().int().min(0),
  allowlist: z.array(z.string()),
  dailyCapUsd: z.number(),
  billing: Billing.default('subscription'),
  status: AgentStatus,
  claudeSessionId: z.string().nullable(),
  createdAt: z.number().int(),
  archivedAt: z.number().int().nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const Session = z.object({
  id: z.string(),
  agentId: z.string(),
  claudeSessionId: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  exitReason: SessionExitReason.nullable(),
  costUsd: z.number(),
  turns: z.number().int(),
  transcriptPath: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

export const GateItem = z.object({
  id: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  loopRunId: z.string().nullable(),
  kind: GateKind,
  label: z.string(),
  detail: z.string(),
  payload: z.unknown().nullable(),
  status: GateStatus,
  decidedBy: DecidedBy.nullable(),
  decision: z.enum(['approved', 'denied']).nullable(),
  decidedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type GateItem = z.infer<typeof GateItem>;

export const FeedEvent = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  level: EventLevel,
  message: z.string(),
  createdAt: z.number().int(),
});
export type FeedEvent = z.infer<typeof FeedEvent>;

export const Pulse = z.object({
  id: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  windowStart: z.number().int(),
  windowEnd: z.number().int(),
  finding: z.string(),
  clean: z.boolean(),
  createdAt: z.number().int(),
});
export type Pulse = z.infer<typeof Pulse>;

/** Read-only tools that may auto-approve. Anything else goes to the gate. */
export const DEFAULT_ALLOWLIST = ['Read', 'Grep', 'Glob'] as const;

/** Bash invocations matching these are treated as read-only. */
export const READONLY_BASH_PREFIXES = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'grep',
  'rg',
  'fd',
  'find',
  'echo',
  'date',
  'env',
  'printenv',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'git rev-parse',
  'git config --get',
  'git blame',
  'git stash list',
  'npm ls',
  'pnpm ls',
  'node --version',
  'node -v',
  'npm view',
  'jq',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed -n',
  'basename',
  'dirname',
  'realpath',
] as const;
