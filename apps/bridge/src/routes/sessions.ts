import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { Runtime } from '../runtime.js';
import type { Supervisor } from '../supervisor.js';
import { sessions } from '../db/schema.js';
import { getAgent, rowToSession } from '../repo.js';
import { readTranscript } from '../transcripts.js';

const RunBody = z.object({
  prompt: z.string().optional(),
  instruction: z.string().optional(),
  trigger: z.enum(['manual', 'heartbeat', 'loop', 'launch']).default('manual'),
  resume: z.boolean().optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  /** When true the request returns as soon as the session is queued. */
  wait: z.boolean().default(false),
});

/** Mounted at /agents — the run trigger lives beside the agent it wakes. */
export function runRoutes(rt: Runtime, sup: Supervisor): Router {
  const r = Router();

  r.post('/:id/run', async (req, res) => {
    const parsed = RunBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid run request', issues: parsed.error.issues });
      return;
    }
    const agent = getAgent(rt.db, req.params.id);
    if (!agent || agent.archivedAt) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }

    const promise = sup.request({
      agentId: agent.id,
      trigger: parsed.data.trigger,
      prompt: parsed.data.prompt,
      instruction: parsed.data.instruction,
      resume: parsed.data.resume,
      maxTurns: parsed.data.maxTurns,
    });

    if (!parsed.data.wait) {
      // Fire and stream. The console watches the WS, not this response.
      promise.catch(() => {});
      res.status(202).json({ ok: true, queued: true, agentId: agent.id });
      return;
    }

    try {
      const outcome = await promise;
      res.json({ ok: true, outcome });
    } catch (err) {
      res.status(409).json({ ok: false, error: (err as Error).message });
    }
  });

  /** Pause is per-agent; the kill switch is per-fleet. Both are reversible. */
  r.post('/:id/pause', (req, res) => {
    const agent = getAgent(rt.db, req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }
    sup.setAgentStatus(agent.id, 'paused');
    rt.event({ agentId: agent.id, level: 'warn', message: `${agent.name} paused` });
    rt.broadcastFleet({ running: sup.running(), queued: sup.queued() });
    res.json({ ok: true, status: 'paused' });
  });

  r.post('/:id/resume', (req, res) => {
    const agent = getAgent(rt.db, req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }
    sup.setAgentStatus(agent.id, 'idle');
    rt.event({ agentId: agent.id, message: `${agent.name} resumed` });
    rt.broadcastFleet({ running: sup.running(), queued: sup.queued() });
    res.json({ ok: true, status: 'idle' });
  });

  return r;
}

export function sessionRoutes(rt: Runtime, sup: Supervisor): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : null;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    const rows = agentId
      ? rt.db
          .select()
          .from(sessions)
          .where(eq(sessions.agentId, agentId))
          .orderBy(desc(sessions.startedAt))
          .limit(limit)
          .all()
      : rt.db.select().from(sessions).orderBy(desc(sessions.startedAt)).limit(limit).all();
    res.json({ sessions: rows.map(rowToSession) });
  });

  r.get('/live', (_req, res) => {
    res.json({ sessionIds: sup.liveSessionIds(), runner: sup.runnerKind });
  });

  r.get('/:id', (req, res) => {
    const row = rt.db.select().from(sessions).where(eq(sessions.id, req.params.id)).get();
    if (!row) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    res.json({ session: rowToSession(row) });
  });

  r.get('/:id/transcript', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 2000) || 2000, 10_000);
    // ?raw=1 returns the unedited message stream, including every system
    // reminder the CLI injected — the thing you need when auditing a claim.
    const includeRaw = req.query.raw === '1' || req.query.raw === 'true';
    res.json({ lines: readTranscript(req.params.id, limit, includeRaw) });
  });

  r.get('/agent/:agentId/latest', (req, res) => {
    const row = rt.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.agentId, req.params.agentId)))
      .orderBy(desc(sessions.startedAt))
      .limit(1)
      .get();
    res.json({ session: row ? rowToSession(row) : null });
  });

  return r;
}
