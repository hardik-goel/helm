import { eq } from 'drizzle-orm';
import type { EventLevel, FleetStateMsg, ServerMessage } from '@helm/core';
import { getDb, type HelmDb } from './db/index.js';
import { fleetState } from './db/schema.js';
import { ConfigStore } from './config-store.js';
import { Hub } from './hub.js';
import {
  fleetSpendToday,
  listAgents,
  listProjects,
  liveSessions,
  logEvent,
  pendingGateCount,
} from './repo.js';

/**
 * Process-wide handles. One instance per bridge process; passed explicitly to
 * everything else so tests can build a throwaway runtime against a temp
 * HELM_HOME instead of reaching for a global.
 */
export class Runtime {
  readonly db: HelmDb;
  readonly config: ConfigStore;
  readonly hub: Hub;
  /** Set true when the CLI reports an auth problem; drives the login banner. */
  authOk = true;

  constructor(opts?: { db?: HelmDb; config?: ConfigStore; hub?: Hub }) {
    this.db = opts?.db ?? getDb();
    this.config = opts?.config ?? new ConfigStore();
    this.hub = opts?.hub ?? new Hub();
    this.ensureFleetRow();
  }

  private ensureFleetRow(): void {
    const row = this.db.select().from(fleetState).where(eq(fleetState.id, 1)).get();
    if (!row) {
      this.db.insert(fleetState).values({ id: 1, killed: false, updatedAt: Date.now() }).run();
    }
  }

  isKilled(): boolean {
    return this.db.select().from(fleetState).where(eq(fleetState.id, 1)).get()?.killed ?? false;
  }

  setKilled(killed: boolean, reason?: string): void {
    this.db
      .update(fleetState)
      .set({
        killed,
        killedAt: killed ? Date.now() : null,
        killedReason: killed ? (reason ?? 'manual') : null,
        updatedAt: Date.now(),
      })
      .where(eq(fleetState.id, 1))
      .run();
  }

  /** Log to the events table and push it down the pulse feed in one call. */
  event(input: {
    agentId?: string | null;
    projectId?: string | null;
    level?: EventLevel;
    message: string;
    data?: unknown;
  }): void {
    const ev = logEvent(this.db, input);
    this.hub.broadcast({ type: 'feed.event', event: ev });
  }

  send(msg: ServerMessage): void {
    this.hub.broadcast(msg);
  }

  fleetSnapshot(extra?: { running?: number; queued?: string[] }): FleetStateMsg {
    const gov = this.config.get().governor;
    return {
      type: 'fleet.state',
      killed: this.isKilled(),
      authOk: this.authOk,
      governor: {
        maxConcurrent: gov.maxConcurrent,
        running: extra?.running ?? 0,
        queued: extra?.queued ?? [],
      },
      spendTodayUsd: fleetSpendToday(this.db),
      fleetCapUsd: gov.fleetDailyCapUsd,
      projects: listProjects(this.db),
      agents: listAgents(this.db),
      liveSessions: liveSessions(this.db),
      pendingGate: pendingGateCount(this.db),
      at: Date.now(),
    };
  }

  broadcastFleet(extra?: { running?: number; queued?: string[] }): void {
    this.hub.broadcast(this.fleetSnapshot(extra));
  }
}
