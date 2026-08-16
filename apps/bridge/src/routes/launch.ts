import { Router } from 'express';
import { z } from 'zod';
import type { Runtime } from '../runtime.js';
import type { LaunchPad } from '../launch.js';
import { inferProjectName } from '../launch.js';

const LaunchBody = z.object({
  prompt: z.string().min(20, 'a build prompt needs more than a sentence'),
  name: z.string().max(60).optional(),
  model: z.string().optional(),
});

export function launchRoutes(rt: Runtime, pad: LaunchPad): Router {
  const r = Router();

  r.post('/', async (req, res) => {
    const parsed = LaunchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid launch' });
      return;
    }
    if (rt.isKilled()) {
      res.status(409).json({ error: 'fleet is killed — resume before launching' });
      return;
    }
    try {
      const result = await pad.launch(parsed.data);
      res.status(201).json(result);
    } catch (err) {
      rt.event({ level: 'error', message: `launch failed: ${(err as Error).message}` });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Live preview of the inferred name while the operator is still typing. */
  r.post('/preview-name', (req, res) => {
    const prompt = String((req.body as { prompt?: string } | undefined)?.prompt ?? '');
    res.json({ name: prompt ? inferProjectName(prompt) : '' });
  });

  return r;
}
