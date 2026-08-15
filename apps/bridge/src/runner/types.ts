import type { GateKind, SessionExitReason } from '@helm/core';

export type RunnerRole =
  | 'system'
  | 'assistant'
  | 'user'
  | 'tool'
  | 'thinking'
  | 'result'
  | 'gate'
  | 'error';

export interface RunnerMessage {
  role: RunnerRole;
  text: string;
  raw?: unknown;
  /** Emitted as soon as the underlying Claude session id is known. */
  claudeSessionId?: string;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  /** Deterministic classification from packages/core. */
  kind: GateKind;
  reason: string;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface RunSpec {
  /** Helm's own session id. The Claude session id arrives from the runner. */
  sessionId: string;
  agentId: string;
  agentName: string;
  cwd: string;
  prompt: string;
  model: string;
  /** Contents appended to the Claude Code system prompt (HELM.md). */
  systemPromptAppend: string;
  allowlist: string[];
  allowedDomains: string[];
  /** 0 observe · 1 suggest · 2 stage · 3 execute-in-workspace. */
  autonomy: number;
  /** Sub-agents this agent may spawn. 0 means none. */
  maxChildren: number;
  maxTurns: number;
  /** Claude session id to resume so heartbeats share memory. */
  resumeSessionId: string | null;
  billing: 'subscription' | 'api';
  apiKey?: string | null;
  signal: AbortSignal;
  onMessage: (m: RunnerMessage) => void;
  /**
   * Every message the runner sees, before any interpretation. The transcript is
   * the primary record and an audit trail with gaps is not an audit trail — if
   * an agent later says "I was told to X", the operator must be able to check.
   */
  onRaw?: (msg: unknown) => void;
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface RunResult {
  claudeSessionId: string | null;
  costUsd: number;
  turns: number;
  exitReason: SessionExitReason;
  finalText: string;
}

/**
 * One interface, two implementations. The SDK path holds the permission
 * promise open at the gate; the CLI path denies and parks. Swapping between
 * them is a single line in runner/index.ts.
 */
export interface AgentRunner {
  readonly kind: 'sdk' | 'cli';
  run(spec: RunSpec): Promise<RunResult>;
}

/** Errors that mean "the human must run `claude login`", not "retry". */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

const AUTH_PATTERNS = [
  /invalid api key/i,
  /authentication[_ ]failed/i,
  /please run\s+`?\/?login/i,
  /not logged in/i,
  /run\s+`?claude login/i,
  /oauth token (?:has )?expired/i,
  /credentials (?:are )?(?:missing|invalid|expired)/i,
  /unauthorized/i,
];

export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}
