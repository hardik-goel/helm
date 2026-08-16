import express, { type Express } from 'express';
import cors from 'cors';
import { createServer, type Server } from 'node:http';
import type { Runtime } from './runtime.js';
import { fleetRoutes, type FleetControl } from './routes/fleet.js';
import { projectRoutes } from './routes/projects.js';
import { agentRoutes } from './routes/agents.js';

export const BRIDGE_VERSION = '0.1.0';

export interface BridgeDeps {
  rt: Runtime;
  control: FleetControl;
  /** Mounted later as phases land; keeps this file from knowing about them. */
  extraRoutes?: Array<{ path: string; router: express.Router }>;
}

export function buildApp(deps: BridgeDeps): Express {
  const { rt, control } = deps;
  const app = express();

  /**
   * The bridge has no auth by design — it is bound to loopback and the operator
   * is the only user. That makes the browser the attack surface: reflecting any
   * Origin would let any web page you happen to be visiting POST to
   * 127.0.0.1:8787 and approve its own gate items or kill the fleet.
   *
   * So the allowlist is exactly the console. A JSON body also forces a CORS
   * preflight, which a disallowed origin never gets past.
   */
  const consolePort = rt.config.get().governor.consolePort;
  const allowedOrigins = new Set([
    `http://localhost:${consolePort}`,
    `http://127.0.0.1:${consolePort}`,
  ]);
  app.use(
    cors({
      origin: (origin, cb) => {
        // No Origin header at all: curl, wscat, the test suite — not a browser.
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        cb(new Error(`origin not allowed: ${origin}`));
      },
    }),
  );
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: BRIDGE_VERSION,
      killed: rt.isKilled(),
      authOk: rt.authOk,
    });
  });

  app.use('/fleet', fleetRoutes(rt, control));
  app.use('/projects', projectRoutes(rt));
  app.use('/agents', agentRoutes(rt));

  for (const extra of deps.extraRoutes ?? []) {
    app.use(extra.path, extra.router);
  }

  app.use((req, res) => {
    res.status(404).json({ error: `no route ${req.method} ${req.path}` });
  });

  // Anything thrown in a route — including a rejected origin — answers with a
  // clear status instead of a stack trace, and never takes the daemon down.
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const isOrigin = err.message?.startsWith('origin not allowed');
      if (!isOrigin) {
        rt.event({ level: 'error', message: `bridge request failed: ${err.message}` });
      }
      res.status(isOrigin ? 403 : 500).json({ error: err.message });
    },
  );

  return app;
}

export function startServer(
  deps: BridgeDeps,
  port: number,
): Promise<{ server: Server; port: number }> {
  const app = buildApp(deps);
  const server = createServer(app);
  deps.rt.hub.attach(server);
  deps.rt.hub.setSnapshotProvider(() =>
    deps.rt.fleetSnapshot({ running: deps.control.running(), queued: deps.control.queued() }),
  );

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind to loopback only. Helm is a local cockpit, not a service.
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}
