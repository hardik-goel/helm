import { Router } from 'express';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { ids, slugify } from '@helm/core';
import type { Runtime } from '../runtime.js';
import { listProjects } from '../repo.js';
import { reconcileConfigToDb } from '../reconcile.js';
import { expandTilde } from '../paths.js';
import { writeProtocolFile } from '../protocol.js';

const CreateProject = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  url: z.string().url().nullable().optional(),
  tag: z.string().nullable().optional(),
});

const ReorderBody = z.object({ order: z.array(z.string()) });

export function projectRoutes(rt: Runtime): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json({ projects: listProjects(rt.db) });
  });

  r.post('/', (req, res) => {
    const parsed = CreateProject.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid project', issues: parsed.error.issues });
      return;
    }
    const path = expandTilde(parsed.data.path);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      res.status(400).json({ error: `not a directory: ${path}` });
      return;
    }

    const id = ids.project();
    const cfg = rt.config.update((draft) => {
      draft.projects.push({
        id,
        name: parsed.data.name,
        path,
        url: parsed.data.url ?? null,
        tag: parsed.data.tag ?? slugify(parsed.data.name),
        order: draft.projects.length,
      });
      return draft;
    });
    reconcileConfigToDb(rt.db, cfg);
    writeProtocolFile({ projectPath: path, projectName: parsed.data.name, agents: [] });
    rt.event({ projectId: id, message: `project registered: ${parsed.data.name}` });
    rt.broadcastFleet();
    res.status(201).json({ project: listProjects(rt.db).find((p) => p.id === id) });
  });

  /** Tree order is governor wake priority, so this endpoint has teeth. */
  r.post('/reorder', (req, res) => {
    const parsed = ReorderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'expected { order: string[] }' });
      return;
    }
    const cfg = rt.config.update((draft) => {
      const rank = new Map(parsed.data.order.map((id, i) => [id, i]));
      for (const p of draft.projects) {
        p.order = rank.get(p.id) ?? draft.projects.length;
      }
      draft.projects.sort((a, b) => a.order - b.order);
      return draft;
    });
    reconcileConfigToDb(rt.db, cfg);
    rt.broadcastFleet();
    res.json({ projects: listProjects(rt.db) });
  });

  r.patch('/:id', (req, res) => {
    const patch = CreateProject.partial().safeParse(req.body);
    if (!patch.success) {
      res.status(400).json({ error: 'invalid patch' });
      return;
    }
    const cfg = rt.config.update((draft) => {
      const p = draft.projects.find((x) => x.id === req.params.id);
      if (!p) return draft;
      if (patch.data.name) p.name = patch.data.name;
      if (patch.data.path) p.path = expandTilde(patch.data.path);
      if (patch.data.url !== undefined) p.url = patch.data.url ?? null;
      if (patch.data.tag !== undefined) p.tag = patch.data.tag ?? null;
      return draft;
    });
    reconcileConfigToDb(rt.db, cfg);
    rt.broadcastFleet();
    res.json({ project: listProjects(rt.db).find((p) => p.id === req.params.id) });
  });

  /** Archive, never delete. Sessions and logs stay readable forever. */
  r.delete('/:id', (req, res) => {
    const cfg = rt.config.update((draft) => {
      draft.projects = draft.projects.filter((p) => p.id !== req.params.id);
      draft.agents = draft.agents.filter((a) => a.projectId !== req.params.id);
      return draft;
    });
    reconcileConfigToDb(rt.db, cfg);
    rt.event({ projectId: req.params.id, level: 'warn', message: 'project archived' });
    rt.broadcastFleet();
    res.json({ ok: true });
  });

  return r;
}
