import { eq } from 'drizzle-orm';
import type { HelmConfig } from '@helm/core';
import type { HelmDb } from './db/index.js';
import { agents, projects } from './db/schema.js';
import { expandTilde } from './paths.js';

/**
 * ~/.helm/config.json declares the fleet; the database holds its history.
 * Reconciliation is one-directional on boot and on every config write: config
 * rows are upserted into the DB, and DB rows that vanished from config are
 * archived rather than deleted (nothing in Helm is ever hard-deleted).
 */
export function reconcileConfigToDb(db: HelmDb, cfg: HelmConfig): void {
  const now = Date.now();

  const configProjectIds = new Set(cfg.projects.map((p) => p.id));
  for (const p of cfg.projects) {
    const existing = db.select().from(projects).where(eq(projects.id, p.id)).get();
    const values = {
      id: p.id,
      name: p.name,
      path: expandTilde(p.path),
      url: p.url,
      tag: p.tag,
      sortOrder: p.order,
      archivedAt: null,
    };
    if (existing) {
      db.update(projects).set(values).where(eq(projects.id, p.id)).run();
    } else {
      db.insert(projects).values({ ...values, createdAt: now }).run();
    }
  }
  for (const row of db.select().from(projects).all()) {
    if (!configProjectIds.has(row.id) && row.archivedAt === null) {
      db.update(projects).set({ archivedAt: now }).where(eq(projects.id, row.id)).run();
    }
  }

  const configAgentIds = new Set(cfg.agents.map((a) => a.id));
  for (const a of cfg.agents) {
    if (!configProjectIds.has(a.projectId)) continue; // orphan agent: skip, never crash
    const existing = db.select().from(agents).where(eq(agents.id, a.id)).get();
    const values = {
      id: a.id,
      projectId: a.projectId,
      name: a.name,
      role: a.role,
      model: a.model,
      mission: a.mission,
      autonomy: a.autonomy,
      heartbeatMinutes: a.heartbeatMinutes,
      maxChildren: a.maxChildren,
      allowlistJson: JSON.stringify(a.allowlist),
      allowedDomainsJson: JSON.stringify(a.allowedDomains),
      dailyCapUsd: a.dailyCapUsd,
      maxTurns: a.maxTurns,
      billing: a.billing,
      archivedAt: null,
    };
    if (existing) {
      // Never let a config write clobber live runtime state.
      db.update(agents).set(values).where(eq(agents.id, a.id)).run();
    } else {
      db.insert(agents).values({ ...values, status: 'idle', createdAt: now }).run();
    }
  }
  for (const row of db.select().from(agents).all()) {
    if (!configAgentIds.has(row.id) && row.archivedAt === null) {
      db.update(agents)
        .set({ archivedAt: now, status: 'decommissioned' })
        .where(eq(agents.id, row.id))
        .run();
    }
  }
}
