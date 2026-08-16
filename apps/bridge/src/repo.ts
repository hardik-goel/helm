import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  ids,
  type Agent as AgentT,
  type EventLevel,
  type FeedEvent,
  type GateItem,
  type Project as ProjectT,
  type Session as SessionT,
} from '@helm/core';
import type { HelmDb } from './db/index.js';
import { agents, events, gateItems, projects, sessions, spendDaily } from './db/schema.js';

export function localDate(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfLocalDay(at = Date.now()): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function rowToProject(r: typeof projects.$inferSelect): ProjectT {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    url: r.url,
    tag: r.tag,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt,
  };
}

export function rowToAgent(r: typeof agents.$inferSelect): AgentT {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    role: r.role,
    model: r.model,
    mission: r.mission,
    autonomy: r.autonomy as 0 | 1 | 2 | 3,
    heartbeatMinutes: r.heartbeatMinutes,
    maxChildren: r.maxChildren,
    allowlist: parseJsonArray(r.allowlistJson),
    dailyCapUsd: r.dailyCapUsd,
    billing: (r.billing === 'api' ? 'api' : 'subscription') as 'api' | 'subscription',
    status: r.status as AgentT['status'],
    claudeSessionId: r.claudeSessionId,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt,
  };
}

export function rowToSession(r: typeof sessions.$inferSelect): SessionT {
  return {
    id: r.id,
    agentId: r.agentId,
    claudeSessionId: r.claudeSessionId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitReason: r.exitReason as SessionT['exitReason'],
    costUsd: r.costUsd,
    turns: r.turns,
    transcriptPath: r.transcriptPath,
  };
}

export function rowToGateItem(r: typeof gateItems.$inferSelect): GateItem {
  return {
    id: r.id,
    agentId: r.agentId,
    sessionId: r.sessionId,
    loopRunId: r.loopRunId,
    kind: r.kind as GateItem['kind'],
    label: r.label,
    detail: r.detail,
    payload: r.payloadJson ? safeParse(r.payloadJson) : null,
    status: r.status as GateItem['status'],
    decidedBy: r.decidedBy as GateItem['decidedBy'],
    decision: r.decision as GateItem['decision'],
    decidedAt: r.decidedAt,
    createdAt: r.createdAt,
  };
}

export function listProjects(db: HelmDb): ProjectT[] {
  return db
    .select()
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(projects.sortOrder)
    .all()
    .map(rowToProject);
}

export function listAgents(db: HelmDb): AgentT[] {
  return db
    .select()
    .from(agents)
    .where(isNull(agents.archivedAt))
    .all()
    .map(rowToAgent);
}

export function getAgent(db: HelmDb, id: string) {
  return db.select().from(agents).where(eq(agents.id, id)).get();
}

export function getProject(db: HelmDb, id: string) {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function liveSessions(db: HelmDb): SessionT[] {
  return db
    .select()
    .from(sessions)
    .where(isNull(sessions.endedAt))
    .all()
    .map(rowToSession);
}

export function pendingGateCount(db: HelmDb): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(gateItems)
    .where(eq(gateItems.status, 'pending'))
    .get();
  return row?.n ?? 0;
}

/** Law 6's helper: nothing happens in Helm without a row explaining it. */
export function logEvent(
  db: HelmDb,
  input: {
    agentId?: string | null;
    projectId?: string | null;
    level?: EventLevel;
    message: string;
    data?: unknown;
  },
): FeedEvent {
  const row = {
    id: ids.event(),
    agentId: input.agentId ?? null,
    projectId: input.projectId ?? null,
    level: input.level ?? 'info',
    message: input.message,
    dataJson: input.data === undefined ? null : JSON.stringify(input.data),
    createdAt: Date.now(),
  };
  db.insert(events).values(row).run();
  return {
    id: row.id,
    agentId: row.agentId,
    level: row.level,
    message: row.message,
    createdAt: row.createdAt,
  };
}

export function recentEvents(db: HelmDb, limit = 50): FeedEvent[] {
  return db
    .select()
    .from(events)
    .orderBy(desc(events.createdAt))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      agentId: r.agentId,
      level: r.level as EventLevel,
      message: r.message,
      createdAt: r.createdAt,
    }))
    .reverse();
}

export function addSpend(db: HelmDb, agentId: string, costUsd: number, at = Date.now()): void {
  if (!costUsd) return;
  const date = localDate(at);
  db.insert(spendDaily)
    .values({ date, agentId, costUsd })
    .onConflictDoUpdate({
      target: [spendDaily.date, spendDaily.agentId],
      set: { costUsd: sql`${spendDaily.costUsd} + ${costUsd}` },
    })
    .run();
}

export function agentSpendToday(db: HelmDb, agentId: string, at = Date.now()): number {
  const row = db
    .select()
    .from(spendDaily)
    .where(and(eq(spendDaily.date, localDate(at)), eq(spendDaily.agentId, agentId)))
    .get();
  return row?.costUsd ?? 0;
}

export function fleetSpendToday(db: HelmDb, at = Date.now()): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${spendDaily.costUsd}), 0)` })
    .from(spendDaily)
    .where(eq(spendDaily.date, localDate(at)))
    .get();
  return row?.total ?? 0;
}

export function sessionsSince(db: HelmDb, since: number): SessionT[] {
  return db
    .select()
    .from(sessions)
    .where(gte(sessions.startedAt, since))
    .orderBy(desc(sessions.startedAt))
    .all()
    .map(rowToSession);
}

function parseJsonArray(s: string): string[] {
  const v = safeParse(s);
  return Array.isArray(v) ? v.map(String) : [];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
