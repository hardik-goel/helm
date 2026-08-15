import { Router } from 'express';
import { z } from 'zod';
import { GovernorConfig } from '@helm/core';
import type { Runtime } from '../runtime.js';
import { recentEvents } from '../repo.js';

/** Implemented by the Supervisor once it exists; kept narrow on purpose. */
export interface FleetControl {
  running(): number;
  queued(): string[];
  killAll(reason: string): Promise<void>;
  resumeAll(): Promise<void>;
}

export function fleetRoutes(rt: Runtime, control: FleetControl): Router {
  const r = Router();

  r.get('/state', (_req, res) => {
    res.json(rt.fleetSnapshot({ running: control.running(), queued: control.queued() }));
  });

  r.get('/events', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    res.json({ events: recentEvents(rt.db, limit) });
  });

  /** Law 3. Must complete inside 2 seconds and survive a bridge restart. */
  r.post('/kill', async (req, res) => {
    const reason = String((req.body as { reason?: string } | undefined)?.reason ?? 'manual');
    const t0 = Date.now();
    await control.killAll(reason);
    rt.setKilled(true, reason);
    rt.event({ level: 'critical', message: `KILL SWITCH — fleet halted (${reason})` });
    rt.broadcastFleet({ running: control.running(), queued: control.queued() });
    res.json({ ok: true, killed: true, elapsedMs: Date.now() - t0 });
  });

  r.post('/resume', async (_req, res) => {
    rt.setKilled(false);
    await control.resumeAll();
    rt.event({ level: 'warn', message: 'fleet resumed' });
    rt.broadcastFleet({ running: control.running(), queued: control.queued() });
    res.json({ ok: true, killed: false });
  });

  r.get('/config', (_req, res) => res.json({ config: rt.config.get() }));

  r.patch('/config/governor', (req, res) => {
    const parsed = GovernorConfig.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid governor settings', issues: parsed.error.issues });
      return;
    }
    const cfg = rt.config.update((draft) => {
      Object.assign(draft.governor, parsed.data);
      return draft;
    });
    rt.event({ message: 'governor settings updated' });
    rt.broadcastFleet({ running: control.running(), queued: control.queued() });
    res.json({ governor: cfg.governor });
  });

  return r;
}

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  killed: z.boolean(),
  authOk: z.boolean(),
});
