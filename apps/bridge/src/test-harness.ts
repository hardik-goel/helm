import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ids, validateLoop } from '@helm/core';
import { LoopRegistry } from './loops/registry.js';
import { LoopEngine } from './loops/engine.js';
import { LoopWatchdog } from './loops/watchdog.js';
import { LoopScheduler } from './loops/scheduler.js';
import { openDb, type HelmDb } from './db/index.js';
import { ConfigStore } from './config-store.js';
import { Hub } from './hub.js';
import { Runtime } from './runtime.js';
import { GateService } from './gate-service.js';
import { Supervisor } from './supervisor.js';
import { reconcileConfigToDb } from './reconcile.js';
import type { AgentRunner, RunResult, RunSpec } from './runner/types.js';

/**
 * Test-only wiring. Lives in src (not test/) so it typechecks with the same
 * strictness as the code it exercises.
 */
export interface Harness {
  db: HelmDb;
  rt: Runtime;
  gate: GateService;
  sup: Supervisor;
  workspace: string;
  addProject(name?: string): string;
  addAgent(projectId: string, overrides?: Record<string, unknown>): string;
  close(): void;
}

export function makeHarness(runner: AgentRunner, opts?: { maxConcurrent?: number }): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'helm-h-'));
  const { db, raw } = openDb(join(dir, 'helm.db'));
  const config = new ConfigStore(join(dir, 'config.json'));
  if (opts?.maxConcurrent !== undefined) {
    config.update((d) => {
      d.governor.maxConcurrent = opts.maxConcurrent!;
      return d;
    });
  }
  const rt = new Runtime({ db, config, hub: new Hub() });
  const gate = new GateService(rt);
  const sup = new Supervisor(rt, gate, runner);

  const workspace = mkdtempSync(join(tmpdir(), 'helm-ws-'));

  return {
    db,
    rt,
    gate,
    sup,
    workspace,
    addProject(name = 'demo') {
      const id = ids.project();
      const cfg = config.update((d) => {
        d.projects.push({
          id,
          name,
          path: workspace,
          url: null,
          tag: name,
          order: d.projects.length,
        });
        return d;
      });
      reconcileConfigToDb(db, cfg);
      return id;
    },
    addAgent(projectId, overrides = {}) {
      const id = ids.agent();
      const cfg = config.update((d) => {
        d.agents.push({
          id,
          projectId,
          name: 'argus',
          role: 'watcher',
          model: 'claude-sonnet-5',
          mission: 'watch the thing',
          autonomy: 1,
          heartbeatMinutes: 0,
          maxChildren: 0,
          allowlist: ['Read', 'Grep', 'Glob'],
          allowedDomains: [],
          dailyCapUsd: 2,
          maxTurns: 10,
          billing: 'subscription',
          keychainAccount: null,
          ...overrides,
        });
        return d;
      });
      reconcileConfigToDb(db, cfg);
      return id;
    },
    close() {
      raw.close();
    },
  };
}

export interface LoopKit {
  registry: LoopRegistry;
  engine: LoopEngine;
  watchdog: LoopWatchdog;
  scheduler: LoopScheduler;
  /** Register a definition object directly, without touching the loops folder. */
  add(def: unknown, opts?: { enabled?: boolean }): string;
}

/** Loop machinery wired to an existing harness. */
export function makeLoops(h: Harness): LoopKit {
  const registry = new LoopRegistry(h.rt);
  const engine = new LoopEngine(h.rt, registry, h.sup, h.gate);
  const watchdog = new LoopWatchdog(h.rt, registry, engine);
  const scheduler = new LoopScheduler(h.rt, registry, engine);

  return {
    registry,
    engine,
    watchdog,
    scheduler,
    add(def, opts) {
      const res = validateLoop(def);
      if (!res.ok) throw new Error(`test loop is invalid: ${JSON.stringify(res.errors)}`);
      const row = registry.upsert(res.loop, null);
      if (opts?.enabled !== false) registry.setStatus(row.id, 'enabled');
      return row.id;
    },
  };
}

export type FakeScript = (spec: RunSpec) => Promise<RunResult>;

/** A runner that does exactly what a test tells it to, and nothing else. */
export class FakeRunner implements AgentRunner {
  readonly kind = 'sdk' as const;
  readonly specs: RunSpec[] = [];

  constructor(private script: FakeScript) {}

  setScript(script: FakeScript): void {
    this.script = script;
  }

  async run(spec: RunSpec): Promise<RunResult> {
    this.specs.push(spec);
    return this.script(spec);
  }
}

export function okResult(over: Partial<RunResult> = {}): RunResult {
  return {
    claudeSessionId: 'claude-session-1',
    costUsd: 0.01,
    turns: 2,
    exitReason: 'completed',
    finalText: 'CLEAN: nothing to report.',
    ...over,
  };
}
