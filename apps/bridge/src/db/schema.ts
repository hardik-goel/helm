import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    url: text('url'),
    tag: text('tag'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
    /** Never hard-delete. Archive. */
    archivedAt: integer('archived_at'),
  },
  (t) => ({
    orderIdx: index('projects_sort_order_idx').on(t.sortOrder),
  }),
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    role: text('role').notNull().default('operator'),
    model: text('model').notNull(),
    mission: text('mission').notNull().default(''),
    autonomy: integer('autonomy').notNull().default(1),
    heartbeatMinutes: integer('heartbeat_minutes').notNull().default(0),
    maxChildren: integer('max_children').notNull().default(0),
    allowlistJson: text('allowlist_json').notNull().default('["Read","Grep","Glob"]'),
    allowedDomainsJson: text('allowed_domains_json').notNull().default('[]'),
    dailyCapUsd: real('daily_cap_usd').notNull().default(2),
    maxTurns: integer('max_turns').notNull().default(30),
    billing: text('billing').notNull().default('subscription'),
    status: text('status').notNull().default('idle'),
    /** Last Claude session id, so heartbeats resume with memory. */
    claudeSessionId: text('claude_session_id'),
    lastRunAt: integer('last_run_at'),
    createdAt: integer('created_at').notNull().default(now),
    archivedAt: integer('archived_at'),
  },
  (t) => ({
    projectIdx: index('agents_project_idx').on(t.projectId),
    statusIdx: index('agents_status_idx').on(t.status),
  }),
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    claudeSessionId: text('claude_session_id'),
    startedAt: integer('started_at').notNull().default(now),
    endedAt: integer('ended_at'),
    exitReason: text('exit_reason'),
    costUsd: real('cost_usd').notNull().default(0),
    turns: integer('turns').notNull().default(0),
    transcriptPath: text('transcript_path'),
    trigger: text('trigger').notNull().default('manual'),
    archivedAt: integer('archived_at'),
  },
  (t) => ({
    agentIdx: index('sessions_agent_idx').on(t.agentId),
    startedIdx: index('sessions_started_idx').on(t.startedAt),
  }),
);

export const pulses = sqliteTable(
  'pulses',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    sessionId: text('session_id'),
    windowStart: integer('window_start').notNull(),
    windowEnd: integer('window_end').notNull(),
    finding: text('finding').notNull(),
    /** Law 6: a clean pulse still writes a row. */
    clean: integer('clean', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({
    agentIdx: index('pulses_agent_idx').on(t.agentId),
    createdIdx: index('pulses_created_idx').on(t.createdAt),
  }),
);

export const gateItems = sqliteTable(
  'gate_items',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    sessionId: text('session_id'),
    loopRunId: text('loop_run_id'),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    detail: text('detail').notNull().default(''),
    payloadJson: text('payload_json'),
    status: text('status').notNull().default('pending'),
    /**
     * Law 1 made queryable. Nothing executes unless this reads 'human' and
     * decision reads 'approved'.
     */
    decidedBy: text('decided_by'),
    decision: text('decision'),
    decidedAt: integer('decided_at'),
    /** Set once the approved payload actually ran, with its result. */
    executedAt: integer('executed_at'),
    executionResult: text('execution_result'),
    /** Where the item came from: permission callback or PROPOSED ACTIONS parse. */
    source: text('source').notNull().default('permission-callback'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({
    statusIdx: index('gate_items_status_idx').on(t.status),
    agentIdx: index('gate_items_agent_idx').on(t.agentId),
  }),
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id'),
    projectId: text('project_id'),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
    dataJson: text('data_json'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({
    createdIdx: index('events_created_idx').on(t.createdAt),
    agentIdx: index('events_agent_idx').on(t.agentId),
  }),
);

export const spendDaily = sqliteTable(
  'spend_daily',
  {
    /** Local YYYY-MM-DD. */
    date: text('date').notNull(),
    agentId: text('agent_id').notNull(),
    costUsd: real('cost_usd').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.date, t.agentId] }),
  }),
);

export const loops = sqliteTable(
  'loops',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    filePath: text('file_path'),
    definitionJson: text('definition_json').notNull(),
    triggerType: text('trigger_type').notNull(),
    status: text('status').notNull().default('disabled'),
    iterationsToday: integer('iterations_today').notNull().default(0),
    iterationsDate: text('iterations_date'),
    spendTodayUsd: real('spend_today_usd').notNull().default(0),
    budgetPerRunUsd: real('budget_per_run_usd').notNull(),
    budgetPerDayUsd: real('budget_per_day_usd').notNull(),
    maxIterationsPerDay: integer('max_iterations_per_day').notNull(),
    lastOutcome: text('last_outcome'),
    lastRunAt: integer('last_run_at'),
    parkedReason: text('parked_reason'),
    createdAt: integer('created_at').notNull().default(now),
    archivedAt: integer('archived_at'),
  },
  (t) => ({
    statusIdx: index('loops_status_idx').on(t.status),
  }),
);

export const loopRuns = sqliteTable(
  'loop_runs',
  {
    id: text('id').primaryKey(),
    loopId: text('loop_id')
      .notNull()
      .references(() => loops.id),
    triggerDetail: text('trigger_detail').notNull().default('manual'),
    startedAt: integer('started_at').notNull().default(now),
    endedAt: integer('ended_at'),
    outcome: text('outcome'),
    stepsTraceJson: text('steps_trace_json').notNull().default('[]'),
    /** Serialized run scope so a gate-parked run resumes after a bridge restart. */
    scopeJson: text('scope_json').notNull().default('{}'),
    resumeStepIndex: integer('resume_step_index'),
    waitingGateId: text('waiting_gate_id'),
    costUsd: real('cost_usd').notNull().default(0),
  },
  (t) => ({
    loopIdx: index('loop_runs_loop_idx').on(t.loopId),
    startedIdx: index('loop_runs_started_idx').on(t.startedAt),
  }),
);

export const loopMemory = sqliteTable(
  'loop_memory',
  {
    loopId: text('loop_id').notNull(),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.loopId, t.key] }),
  }),
);

/** Single-row table holding fleet state that must survive a daemon restart. */
export const fleetState = sqliteTable('fleet_state', {
  id: integer('id').primaryKey().default(1),
  killed: integer('killed', { mode: 'boolean' }).notNull().default(false),
  killedAt: integer('killed_at'),
  killedReason: text('killed_reason'),
  updatedAt: integer('updated_at').notNull().default(now),
});
