import { Router } from 'express';
import type { Runtime } from '../runtime.js';
import { buildStandup, standupToMarkdown } from '../standup.js';

export function standupRoutes(rt: Runtime): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours ?? 24) || 24, 1), 24 * 30);
    const digest = buildStandup(rt.db, hours);
    res.json({ digest, markdown: standupToMarkdown(digest) });
  });

  return r;
}
