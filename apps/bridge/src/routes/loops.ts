import { Router } from 'express';
import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateLoop } from '@helm/core';
import { paths } from '../paths.js';
import type { Runtime } from '../runtime.js';
import type { LoopRegistry } from '../loops/registry.js';
import type { LoopEngine } from '../loops/engine.js';
import type { LoopWatchdog } from '../loops/watchdog.js';

const StatusBody = z.object({ status: z.enum(['enabled', 'parked', 'disabled']) });
const SourceBody = z.object({ yaml: z.string().min(1) });
const ImportBody = z.object({
  yaml: z.string().min(1),
  memory: z.record(z.unknown()).optional(),
  overwrite: z.boolean().default(false),
});

export function loopRoutes(
  rt: Runtime,
  registry: LoopRegistry,
  engine: LoopEngine,
  watchdog: LoopWatchdog,
): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    const loops = registry.list().map((l) => ({
      id: l.id,
      name: l.name,
      description: l.definition.description,
      trigger: l.definition.trigger,
      bounds: l.definition.bounds,
      memory: l.definition.memory,
      steps: l.definition.steps.length,
      status: l.status,
      parkedReason: l.parkedReason,
      iterationsToday: l.iterationsToday,
      spendTodayUsd: l.spendTodayUsd,
      lastOutcome: l.lastOutcome,
      lastRunAt: l.lastRunAt,
      missingAgents: registry.missingAgents(l.definition),
      history: engine.recentRuns(l.id, 20).map((run) => ({
        id: run.id,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        outcome: run.outcome,
        costUsd: run.costUsd,
        waitingGateId: run.waitingGateId,
      })),
    }));
    res.json({ loops });
  });

  r.get('/:id/memory', (req, res) => {
    const loop = registry.get(req.params.id);
    if (!loop) {
      res.status(404).json({ error: 'no such loop' });
      return;
    }
    res.json({ memory: engine.readMemory(loop.id) });
  });

  r.delete('/:id/memory', (req, res) => {
    const loop = registry.get(req.params.id);
    if (!loop) {
      res.status(404).json({ error: 'no such loop' });
      return;
    }
    res.json({ cleared: engine.clearMemory(loop.id) });
  });

  r.get('/:id/source', (req, res) => {
    const yaml = registry.readSource(req.params.id);
    if (yaml === null) {
      res.status(404).json({ error: 'no source file for this loop' });
      return;
    }
    res.json({ yaml });
  });

  r.post('/:id/source', (req, res) => {
    const parsed = SourceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'expected { yaml: string }' });
      return;
    }
    const result = registry.writeSource(req.params.id, parsed.data.yaml);
    if (!result.ok) {
      res.status(400).json({ ok: false, errors: result.errors });
      return;
    }
    res.json({ ok: true, loop: { id: result.loop.id, name: result.loop.name } });
  });

  /** Validate without saving, so the editor can show errors as you type. */
  r.post('/validate', (req, res) => {
    const parsed = SourceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, errors: [{ path: '(body)', message: 'expected yaml' }] });
      return;
    }
    let raw: unknown;
    try {
      raw = parseYaml(parsed.data.yaml);
    } catch (err) {
      res.json({ ok: false, errors: [{ path: '(yaml)', message: (err as Error).message }] });
      return;
    }
    const result = validateLoop(raw);
    res.json(result.ok ? { ok: true } : { ok: false, errors: result.errors });
  });

  r.post('/:id/status', (req, res) => {
    const parsed = StatusBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'expected { status }' });
      return;
    }
    const result = registry.setStatus(req.params.id, parsed.data.status);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, status: result.loop.status });
  });

  r.post('/:id/run', async (req, res) => {
    const result = await engine.run(req.params.id, 'manual');
    if ('refused' in result) {
      res.status(409).json({ ok: false, error: result.refused });
      return;
    }
    res.json({ ok: true, run: result });
  });

  /**
   * Export a loop as a portable bundle. Memory is opt-in: what a loop learned
   * about one machine's repos is usually noise on another's.
   */
  r.get('/:id/export', (req, res) => {
    const loop = registry.get(req.params.id);
    if (!loop) {
      res.status(404).json({ error: 'no such loop' });
      return;
    }
    const withMemory = req.query.memory === '1' || req.query.memory === 'true';
    res.json({
      helmLoopBundle: 1,
      exportedAt: Date.now(),
      yaml: registry.readSource(loop.id) ?? stringifyYaml(loop.definition),
      memory: withMemory ? engine.readMemory(loop.id) : undefined,
    });
  });

  r.post('/import', (req, res) => {
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'expected { yaml, memory? }', issues: parsed.error.issues });
      return;
    }

    let raw: unknown;
    try {
      raw = parseYaml(parsed.data.yaml);
    } catch (err) {
      res.status(400).json({ ok: false, errors: [{ path: '(yaml)', message: (err as Error).message }] });
      return;
    }
    // An imported loop is validated exactly like a local one — Law 8 does not
    // relax for something that arrived from another machine.
    const valid = validateLoop(raw);
    if (!valid.ok) {
      res.status(400).json({ ok: false, errors: valid.errors });
      return;
    }
    if (registry.get(valid.loop.name) && !parsed.data.overwrite) {
      res.status(409).json({ error: `a loop named ${valid.loop.name} already exists` });
      return;
    }

    const file = join(paths.loops, `${valid.loop.name}.yaml`);
    writeFileSync(file, parsed.data.yaml, 'utf8');
    // Imported loops arrive disabled, whatever the file says.
    const loop = registry.upsert({ ...valid.loop, enabled: false }, file);
    registry.setStatus(loop.id, 'disabled');

    if (parsed.data.memory) engine.writeMemory(loop.id, parsed.data.memory);

    rt.event({
      level: 'warn',
      message: `loop ${loop.name} imported — review it and enable it yourself`,
    });
    res.status(201).json({
      ok: true,
      loop: { id: loop.id, name: loop.name, status: 'disabled' },
      missingAgents: registry.missingAgents(valid.loop),
    });
  });

  /** The retro loop is enabled per agent, from that agent's Mission view. */
  r.get('/retro/for/:agentId', (req, res) => {
    const agent = rt.config.get().agents.find((a) => a.id === req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }
    const loop = registry.get(registry.retroLoopName(agent.name));
    res.json({
      enabled: loop?.status === 'enabled',
      loop: loop ? { id: loop.id, name: loop.name, status: loop.status } : null,
    });
  });

  r.post('/retro/for/:agentId', (req, res) => {
    const enable = (req.body as { enabled?: boolean } | undefined)?.enabled !== false;
    if (!enable) {
      res.json({ enabled: false, ok: registry.disableRetroFor(req.params.agentId) });
      return;
    }
    const result = registry.enableRetroFor(req.params.agentId);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ enabled: true, loop: { id: result.loop.id, name: result.loop.name } });
  });

  r.post('/reload', (_req, res) => {
    const { registered, failures } = registry.loadAll();
    res.json({ registered: registered.map((l) => l.name), failures });
  });

  r.post('/watchdog/sweep', (_req, res) => {
    res.json({ parked: watchdog.sweep() });
  });

  return r;
}
