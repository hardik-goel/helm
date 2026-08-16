import { Router } from 'express';
import { z } from 'zod';
import { AutonomyLevel, DEFAULT_ALLOWLIST, ids, type AgentConfig } from '@helm/core';
import type { Runtime } from '../runtime.js';
import { getAgent, listAgents, rowToAgent } from '../repo.js';
import { reconcileConfigToDb } from '../reconcile.js';
import { syncProtocol } from '../protocol.js';

const CreateAgent = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  role: z.string().default('operator'),
  model: z.string().optional(),
  mission: z.string().default(''),
  autonomy: AutonomyLevel.default(1),
  heartbeatMinutes: z.number().int().min(0).default(0),
  maxChildren: z.number().int().min(0).default(0),
  allowlist: z.array(z.string()).default([...DEFAULT_ALLOWLIST]),
  allowedDomains: z.array(z.string()).default([]),
  dailyCapUsd: z.number().min(0).default(2),
  maxTurns: z.number().int().min(1).default(30),
});

const PatchAgent = CreateAgent.partial().omit({ projectId: true });

export function agentRoutes(rt: Runtime): Router {
  const r = Router();

  r.get('/', (_req, res) => res.json({ agents: listAgents(rt.db) }));

  r.get('/:id', (req, res) => {
    const row = getAgent(rt.db, req.params.id);
    if (!row) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }
    res.json({ agent: rowToAgent(row) });
  });

  r.post('/', (req, res) => {
    const parsed = CreateAgent.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid agent', issues: parsed.error.issues });
      return;
    }
    const cfg0 = rt.config.get();
    const project = cfg0.projects.find((p) => p.id === parsed.data.projectId);
    if (!project) {
      res.status(400).json({ error: 'no such project' });
      return;
    }

    const id = ids.agent();
    const cfg = rt.config.update((draft) => {
      draft.agents.push({
        ...parsed.data,
        id,
        model: parsed.data.model ?? draft.governor.defaultModel,
        billing: 'subscription',
        keychainAccount: null,
      } as AgentConfig);
      return draft;
    });
    reconcileConfigToDb(rt.db, cfg);
    refreshProtocol(rt, parsed.data.projectId);
    rt.event({ agentId: id, message: `agent recruited: ${parsed.data.name}` });
    rt.broadcastFleet();
    res.status(201).json({ agent: rowToAgent(getAgent(rt.db, id)!) });
  });

  r.patch('/:id', (req, res) => {
    const parsed = PatchAgent.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid patch', issues: parsed.error.issues });
      return;
    }
    let projectId: string | null = null;
    const cfg = rt.config.update((draft) => {
      const a = draft.agents.find((x) => x.id === req.params.id);
      if (!a) return draft;
      projectId = a.projectId;
      Object.assign(a, parsed.data);
      return draft;
    });
    if (!projectId) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }
    reconcileConfigToDb(rt.db, cfg);
    refreshProtocol(rt, projectId);
    rt.broadcastFleet();
    res.json({ agent: rowToAgent(getAgent(rt.db, req.params.id)!) });
  });

  r.delete('/:id', (req, res) => {
    let projectId: string | null = null;
    const cfg = rt.config.update((draft) => {
      const a = draft.agents.find((x) => x.id === req.params.id);
      if (a) projectId = a.projectId;
      draft.agents = draft.agents.filter((x) => x.id !== req.params.id);
      return draft;
    });
    reconcileConfigToDb(rt.db, cfg);
    if (projectId) refreshProtocol(rt, projectId);
    rt.event({ agentId: req.params.id, level: 'warn', message: 'agent decommissioned' });
    rt.broadcastFleet();
    res.json({ ok: true });
  });

  return r;
}

/** Keep HELM.md in sync with whichever agents currently live on the project. */
export function refreshProtocol(rt: Runtime, projectId: string): void {
  const cfg = rt.config.get();
  const project = cfg.projects.find((p) => p.id === projectId);
  if (!project) return;
  try {
    syncProtocol(cfg, project);
  } catch (err) {
    rt.event({
      projectId,
      level: 'error',
      message: `could not write HELM.md: ${(err as Error).message}`,
    });
  }
}
