import { z } from 'zod';
import {
  Agent,
  AgentStatus,
  FeedEvent,
  GateItem,
  Project,
  Pulse,
  Session,
} from './domain.js';

/**
 * Every message that crosses ws://localhost:8787 is one of these.
 * Both ends parse with the same schema, so a wire change that breaks the
 * console fails loudly in the bridge's tests first.
 */

export const SessionStreamChunk = z.object({
  type: z.literal('session.stream'),
  sessionId: z.string(),
  agentId: z.string(),
  seq: z.number().int(),
  /** Role-coded line for the transcript drawer. */
  role: z.enum(['system', 'assistant', 'user', 'tool', 'thinking', 'result', 'gate', 'error']),
  text: z.string(),
  /** Raw SDK/CLI message, kept so the drawer can render richly later. */
  raw: z.unknown().optional(),
  at: z.number().int(),
});

export const AgentStatusMsg = z.object({
  type: z.literal('agent.status'),
  agentId: z.string(),
  status: AgentStatus,
  sessionId: z.string().nullable().optional(),
  turns: z.number().int().optional(),
  costUsdToday: z.number().optional(),
  detail: z.string().optional(),
  at: z.number().int(),
});

export const GateNewMsg = z.object({
  type: z.literal('gate.new'),
  item: GateItem,
});

export const GateDecidedMsg = z.object({
  type: z.literal('gate.decided'),
  item: GateItem,
});

export const FeedEventMsg = z.object({
  type: z.literal('feed.event'),
  event: FeedEvent,
});

export const GovernorState = z.object({
  maxConcurrent: z.number().int(),
  running: z.number().int(),
  queued: z.array(z.string()),
});

export const FleetStateMsg = z.object({
  type: z.literal('fleet.state'),
  killed: z.boolean(),
  authOk: z.boolean(),
  governor: GovernorState,
  spendTodayUsd: z.number(),
  fleetCapUsd: z.number(),
  projects: z.array(Project),
  agents: z.array(Agent),
  liveSessions: z.array(Session),
  pendingGate: z.number().int(),
  at: z.number().int(),
});

export const PulseMsg = z.object({
  type: z.literal('pulse.new'),
  pulse: Pulse,
});

export const LoopStateMsg = z.object({
  type: z.literal('loop.state'),
  loopId: z.string(),
  status: z.enum(['enabled', 'parked', 'disabled', 'running', 'waiting-gate']),
  iterationsToday: z.number().int(),
  spendTodayUsd: z.number(),
  lastOutcome: z.string().nullable(),
  detail: z.string().optional(),
  at: z.number().int(),
});

export const LaunchStepMsg = z.object({
  type: z.literal('launch.step'),
  launchId: z.string(),
  step: z.enum(['workspace', 'git', 'protocol', 'register', 'session']),
  state: z.enum(['pending', 'active', 'done', 'failed']),
  detail: z.string().optional(),
  projectId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  at: z.number().int(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  SessionStreamChunk,
  AgentStatusMsg,
  GateNewMsg,
  GateDecidedMsg,
  FeedEventMsg,
  FleetStateMsg,
  PulseMsg,
  LoopStateMsg,
  LaunchStepMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Console -> bridge. Deliberately tiny: real actions go over HTTP. */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), since: z.number().int().optional() }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('subscribe.session'), sessionId: z.string() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type SessionStreamChunk = z.infer<typeof SessionStreamChunk>;
export type AgentStatusMsg = z.infer<typeof AgentStatusMsg>;
export type GateNewMsg = z.infer<typeof GateNewMsg>;
export type GateDecidedMsg = z.infer<typeof GateDecidedMsg>;
export type FeedEventMsg = z.infer<typeof FeedEventMsg>;
export type FleetStateMsg = z.infer<typeof FleetStateMsg>;
export type PulseMsg = z.infer<typeof PulseMsg>;
export type LoopStateMsg = z.infer<typeof LoopStateMsg>;
export type LaunchStepMsg = z.infer<typeof LaunchStepMsg>;
export type GovernorState = z.infer<typeof GovernorState>;
