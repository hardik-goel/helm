import { gte } from 'drizzle-orm';
import type { HelmDb } from './db/index.js';
import { gateItems, pulses, sessions } from './db/schema.js';
import { listAgents, listProjects, rowToGateItem } from './repo.js';

export interface StandupProject {
  projectId: string;
  name: string;
  /** What actually changed: finished sessions and executed approvals. */
  moved: string[];
  /** What is stuck: errors, caps, denials. */
  blocked: string[];
  /** What needs the human: pending gate items. */
  waiting: string[];
  sessions: number;
  costUsd: number;
  cleanPulses: number;
  findings: number;
}

export interface StandupDigest {
  generatedAt: number;
  windowHours: number;
  totalCostUsd: number;
  projects: StandupProject[];
}

/**
 * The digest is assembled from database rows only — no LLM call. A standup that
 * needs a model to run is a standup that stops working when the fleet is capped.
 */
export function buildStandup(db: HelmDb, hours = 24, now = Date.now()): StandupDigest {
  const since = now - hours * 3_600_000;

  const projects = listProjects(db);
  const agents = listAgents(db);
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const agentProject = new Map(agents.map((a) => [a.id, a.projectId]));

  const recentSessions = db.select().from(sessions).where(gte(sessions.startedAt, since)).all();
  const recentPulses = db.select().from(pulses).where(gte(pulses.createdAt, since)).all();
  const recentGate = db
    .select()
    .from(gateItems)
    .where(gte(gateItems.createdAt, since))
    .all()
    .map(rowToGateItem);
  // Pending items never expire out of a standup: an approval waiting from
  // yesterday is exactly the thing the operator must see today.
  const pendingOlder = db
    .select()
    .from(gateItems)
    .all()
    .map(rowToGateItem)
    .filter((g) => g.status === 'pending' && g.createdAt < since);

  const byProject = new Map<string, StandupProject>();
  for (const p of projects) {
    byProject.set(p.id, {
      projectId: p.id,
      name: p.name,
      moved: [],
      blocked: [],
      waiting: [],
      sessions: 0,
      costUsd: 0,
      cleanPulses: 0,
      findings: 0,
    });
  }
  const bucket = (agentId: string) => {
    const pid = agentProject.get(agentId);
    return pid ? byProject.get(pid) : undefined;
  };

  for (const s of recentSessions) {
    const b = bucket(s.agentId);
    if (!b) continue;
    b.sessions += 1;
    b.costUsd += s.costUsd;
    const who = agentName.get(s.agentId) ?? s.agentId;
    if (s.exitReason === 'error') b.blocked.push(`${who}: session errored`);
    else if (s.exitReason === 'auth-required') b.blocked.push(`${who}: needs \`claude login\``);
    else if (s.exitReason === 'max-turns') b.blocked.push(`${who}: hit its turn limit`);
  }

  for (const p of recentPulses) {
    const b = bucket(p.agentId);
    if (!b) continue;
    if (p.clean) {
      b.cleanPulses += 1;
    } else {
      b.findings += 1;
      b.moved.push(`${agentName.get(p.agentId) ?? p.agentId}: ${oneLine(p.finding)}`);
    }
  }

  for (const g of [...recentGate, ...pendingOlder]) {
    const b = bucket(g.agentId);
    if (!b) continue;
    const who = agentName.get(g.agentId) ?? g.agentId;
    if (g.status === 'pending') b.waiting.push(`${g.kind}: ${g.label} (${who})`);
    else if (g.status === 'approved') b.moved.push(`approved ${g.kind}: ${g.label}`);
    else if (g.status === 'denied') b.blocked.push(`denied ${g.kind}: ${g.label}`);
    else if (g.status === 'expired') b.blocked.push(`expired unanswered: ${g.label}`);
  }

  for (const a of agents) {
    const b = byProject.get(a.projectId);
    if (!b) continue;
    if (a.status === 'parked-cap') b.blocked.push(`${a.name}: parked at its daily spend cap`);
    if (a.status === 'error') b.blocked.push(`${a.name}: in an error state`);
    if (a.status === 'paused') b.blocked.push(`${a.name}: paused`);
  }

  const list = [...byProject.values()];
  return {
    generatedAt: now,
    windowHours: hours,
    totalCostUsd: list.reduce((n, p) => n + p.costUsd, 0),
    projects: list,
  };
}

export function standupToMarkdown(d: StandupDigest): string {
  const when = new Date(d.generatedAt).toLocaleString();
  const lines: string[] = [
    `# Helm standup — last ${d.windowHours}h`,
    ``,
    `_${when} · $${d.totalCostUsd.toFixed(2)} spent across the fleet_`,
    ``,
  ];

  const active = d.projects.filter(
    (p) => p.sessions > 0 || p.moved.length || p.blocked.length || p.waiting.length,
  );
  if (active.length === 0) {
    lines.push('Nothing ran in this window.');
    return lines.join('\n');
  }

  for (const p of active) {
    lines.push(`## ${p.name}`);
    lines.push(
      `${p.sessions} session${p.sessions === 1 ? '' : 's'} · $${p.costUsd.toFixed(2)} · ` +
        `${p.cleanPulses} clean pulse${p.cleanPulses === 1 ? '' : 's'} · ${p.findings} finding${p.findings === 1 ? '' : 's'}`,
    );
    lines.push('');
    lines.push(...section('What moved', p.moved));
    lines.push(...section('Blocked', p.blocked));
    lines.push(...section('Waiting on you', p.waiting));
  }
  return lines.join('\n');
}

function section(title: string, items: string[]): string[] {
  if (items.length === 0) return [`**${title}.** nothing`, ''];
  return [`**${title}.**`, ...items.map((i) => `- ${i}`), ''];
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}
