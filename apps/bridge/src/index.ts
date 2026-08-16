import { Runtime } from './runtime.js';
import { startServer } from './server.js';
import { reconcileConfigToDb } from './reconcile.js';
import { ensureHelmDirs, paths } from './paths.js';
import { GateService } from './gate-service.js';
import { Supervisor } from './supervisor.js';
import { Scheduler } from './scheduler.js';
import { LaunchPad } from './launch.js';
import { gateRoutes } from './routes/gate.js';
import { launchRoutes } from './routes/launch.js';
import { runRoutes, sessionRoutes } from './routes/sessions.js';
import { standupRoutes } from './routes/standup.js';
import { LoopRegistry } from './loops/registry.js';
import { LoopEngine } from './loops/engine.js';
import { LoopScheduler } from './loops/scheduler.js';
import { LoopWatchdog } from './loops/watchdog.js';
import { loopRoutes } from './routes/loops.js';

async function main(): Promise<void> {
  ensureHelmDirs();

  const rt = new Runtime();
  reconcileConfigToDb(rt.db, rt.config.get());

  const gate = new GateService(rt);
  const supervisor = new Supervisor(rt, gate);

  // A restart is not a clean slate: reconcile what the last process left behind.
  supervisor.reconcileOnBoot();
  gate.reapOrphansOnBoot();

  rt.config.on('change', (cfg) => {
    reconcileConfigToDb(rt.db, cfg);
    rt.broadcastFleet({ running: supervisor.running(), queued: supervisor.queued() });
  });
  rt.config.on('invalid', (issues) => {
    rt.event({ level: 'error', message: `config.json is invalid: ${JSON.stringify(issues)}` });
  });
  rt.config.watch();

  const loopRegistry = new LoopRegistry(rt);
  const seeded = loopRegistry.seedStarters();
  if (seeded) {
    rt.event({ message: `wrote ${seeded} starter loop(s) to ${paths.loops} — all disabled` });
  }
  const { registered, failures } = loopRegistry.loadAll();
  rt.event({
    message: `loops: ${registered.length} registered${failures.length ? `, ${failures.length} refused` : ''}`,
  });

  const loopEngine = new LoopEngine(rt, loopRegistry, supervisor, gate);
  const loopScheduler = new LoopScheduler(rt, loopRegistry, loopEngine);
  const loopWatchdog = new LoopWatchdog(rt, loopRegistry, loopEngine);
  loopScheduler.start();
  loopWatchdog.start();

  // A decision resumes any loop run parked on it, and may trigger new loops.
  gate.on('decided', (item) => {
    void loopScheduler.onGateDecision(item);
  });

  const scheduler = new Scheduler(rt, supervisor, {
    tickMs: Number(process.env.HELM_TICK_MS ?? 15_000),
  });
  scheduler.start();

  const gateSweep = setInterval(
    () => gate.expireStale(rt.config.get().governor.gateTtlMinutes),
    60_000,
  );
  gateSweep.unref();

  const port = rt.config.get().governor.bridgePort;
  const { server } = await startServer(
    {
      rt,
      control: supervisor,
      extraRoutes: [
        { path: '/agents', router: runRoutes(rt, supervisor) },
        { path: '/sessions', router: sessionRoutes(rt, supervisor) },
        { path: '/gate', router: gateRoutes(rt, gate) },
        { path: '/launch', router: launchRoutes(rt, new LaunchPad(rt, supervisor)) },
        { path: '/standup', router: standupRoutes(rt) },
        { path: '/loops', router: loopRoutes(rt, loopRegistry, loopEngine, loopWatchdog) },
      ],
    },
    port,
  );

  rt.event({ message: `bridge up on http://127.0.0.1:${port} (runner: ${supervisor.runnerKind})` });
  process.stdout.write(
    `helm bridge  http://127.0.0.1:${port}  ws://127.0.0.1:${port}/ws  runner=${supervisor.runnerKind}  db ${paths.db}\n`,
  );
  if (rt.isKilled()) {
    process.stdout.write('helm bridge  FLEET IS KILLED — resume from the console to run agents\n');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nhelm bridge  ${signal} — stopping children\n`);
    scheduler.stop();
    loopScheduler.stop();
    loopWatchdog.stop();
    clearInterval(gateSweep);
    await supervisor.killAll(`bridge ${signal}`, { pauseAgents: false });
    await rt.config.close();
    rt.hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException & { port?: number };
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(
      `helm bridge  port ${e.port} is already in use — another bridge is running.\n` +
        `             stop it, or change governor.bridgePort in ${paths.config}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`helm bridge failed to start: ${e.stack}\n`);
  process.exit(1);
});
