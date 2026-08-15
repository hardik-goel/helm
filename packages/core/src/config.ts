import { z } from 'zod';
import { AutonomyLevel, Billing, DEFAULT_ALLOWLIST } from './domain.js';

export const DEFAULT_BRIDGE_PORT = 8787;
export const DEFAULT_CONSOLE_PORT = 3777;

export const ProjectConfig = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  url: z.string().nullable().default(null),
  tag: z.string().nullable().default(null),
  order: z.number().int().default(0),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export const AgentConfig = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  role: z.string().default('operator'),
  model: z.string().default('claude-sonnet-5'),
  mission: z.string().default(''),
  autonomy: AutonomyLevel.default(1),
  heartbeatMinutes: z.number().int().min(0).default(0),
  maxChildren: z.number().int().min(0).default(0),
  allowlist: z.array(z.string()).default([...DEFAULT_ALLOWLIST]),
  allowedDomains: z.array(z.string()).default([]),
  dailyCapUsd: z.number().min(0).default(2),
  maxTurns: z.number().int().min(1).default(30),
  /** Law 7: subscription unless explicitly opted out, key from the keychain only. */
  billing: Billing.default('subscription'),
  keychainAccount: z.string().nullable().default(null),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const GovernorConfig = z.object({
  maxConcurrent: z.number().int().min(1).default(3),
  fleetDailyCapUsd: z.number().min(0).default(20),
  defaultModel: z.string().default('claude-sonnet-5'),
  launchRoot: z.string().default('~/dev/helm-launches'),
  bridgePort: z.number().int().default(DEFAULT_BRIDGE_PORT),
  consolePort: z.number().int().default(DEFAULT_CONSOLE_PORT),
  /** Gate items older than this expire rather than blocking a session forever. */
  gateTtlMinutes: z.number().int().min(1).default(720),
});
export type GovernorConfig = z.infer<typeof GovernorConfig>;

export const HelmConfig = z.object({
  version: z.literal(1).default(1),
  projects: z.array(ProjectConfig).default([]),
  agents: z.array(AgentConfig).default([]),
  governor: GovernorConfig.default({}),
});
export type HelmConfig = z.infer<typeof HelmConfig>;

export const DEFAULT_CONFIG: HelmConfig = HelmConfig.parse({});
