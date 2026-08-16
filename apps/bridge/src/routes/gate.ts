import { Router } from 'express';
import { z } from 'zod';
import type { Runtime } from '../runtime.js';
import type { GateService } from '../gate-service.js';
import { getAgent, getProject } from '../repo.js';

const DecideBody = z.object({ note: z.string().optional() });

/**
 * The human's half of Law 1. Approval only ever enters the system through
 * these routes, driven by the operator sitting in front of the console.
 */
export function gateRoutes(rt: Runtime, gate: GateService): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const status = req.query.status;
    if (status === 'pending') {
      res.json({ items: gate.listPending() });
      return;
    }
    res.json({ items: gate.list(Math.min(Number(req.query.limit ?? 100) || 100, 500)) });
  });

  r.get('/:id', (req, res) => {
    const item = gate.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'no such gate item' });
      return;
    }
    res.json({ item });
  });

  r.post('/:id/approve', async (req, res) => {
    DecideBody.parse(req.body ?? {});
    const item = gate.decide(req.params.id, 'approved');
    if (!item) {
      res.status(409).json({ error: 'gate item is not pending' });
      return;
    }
    const execution = await maybeExecute(rt, gate, item.id);
    res.json({ item: gate.get(item.id), execution });
  });

  r.post('/:id/deny', (req, res) => {
    DecideBody.parse(req.body ?? {});
    const item = gate.decide(req.params.id, 'denied');
    if (!item) {
      res.status(409).json({ error: 'gate item is not pending' });
      return;
    }
    res.json({ item });
  });

  r.post('/approve-all', async (req, res) => {
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : null;
    const pending = gate.listPending().filter((i) => !agentId || i.agentId === agentId);
    const results = [];
    for (const p of pending) {
      const item = gate.decide(p.id, 'approved');
      if (!item) continue;
      results.push({ id: item.id, execution: await maybeExecute(rt, gate, item.id) });
    }
    res.json({ approved: results.length, results });
  });

  return r;
}

/**
 * A permission-callback item is executed by the agent itself once the held
 * promise resolves. A proposed-actions item has no live session waiting, so the
 * bridge runs the approved payload — after `GateService.execute` re-verifies
 * the human approval against the database.
 */
async function maybeExecute(
  rt: Runtime,
  gate: GateService,
  id: string,
): Promise<{ ran: boolean; ok?: boolean; output?: string }> {
  const item = gate.get(id);
  if (!item) return { ran: false };

  const agent = getAgent(rt.db, item.agentId);
  const project = agent ? getProject(rt.db, agent.projectId) : null;
  const cwd = project?.path ?? process.cwd();

  const result = await gate.execute(id, cwd);
  return { ran: true, ok: result.ok, output: result.output };
}
