import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface BridgeHandle {
  child: ChildProcess;
  stop: () => Promise<void>;
}

export interface BridgeOptions {
  /** Bundled bridge entry (build/bridge.cjs). */
  entry: string;
  /** Folder holding the Drizzle migrations shipped beside the bundle. */
  migrationsDir: string;
  packaged: boolean;
  onLog: (line: string) => void;
  onExit: (code: number | null) => void;
}

/**
 * Runs the daemon as a child process rather than inside the window process.
 *
 * It owns real child processes and a SQLite file, and the kill switch has to be
 * able to take it down cleanly — all of which is easier when it is a process in
 * its own right, exactly as it is when you run `pnpm helm`.
 */
export function startBridge(opts: BridgeOptions): BridgeHandle {
  if (!existsSync(opts.entry)) {
    throw new Error(`bridge bundle is missing at ${opts.entry} — run the desktop build first`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HELM_MIGRATIONS_DIR: opts.migrationsDir,
  };

  let command: string;
  let args: string[];

  if (opts.packaged) {
    // In the packaged app the only runtime we can count on is the one inside
    // Electron. Its native modules are rebuilt for this ABI at package time.
    command = process.execPath;
    args = [opts.entry];
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    // In development the bundle's native modules are built for system Node, so
    // that is what runs it. Keeps `pnpm desktop` working without a rebuild.
    command = process.env.HELM_NODE_BIN || 'node';
    args = [opts.entry];
  }

  opts.onLog(`starting daemon: ${command} ${args.join(' ')}`);

  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Without this, a failed spawn emits an unhandled 'error' and the app sits
  // there with no daemon and nothing said about why.
  child.on('error', (err) => {
    opts.onLog(`daemon failed to start: ${err.message}`);
    opts.onExit(null);
  });

  const relay = (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim()) opts.onLog(line);
    }
  };
  child.stdout?.on('data', relay);
  child.stderr?.on('data', relay);
  child.on('exit', (code) => opts.onExit(code));

  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      const done = () => resolve();
      child.once('exit', done);
      child.kill('SIGTERM');
      // The daemon stops its own children first; if it somehow does not
      // answer, do not hold the app open waiting for it.
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 4000).unref?.();
    });

  return { child, stop };
}

