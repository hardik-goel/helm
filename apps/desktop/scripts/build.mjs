#!/usr/bin/env node
/**
 * Assembles everything the desktop app ships:
 *
 *   build/main.cjs      the Electron main process
 *   build/bridge.cjs    the daemon, bundled to one file
 *   build/console/      the cockpit, exported to static files
 *   build/drizzle/      database migrations the daemon runs on boot
 *   build/assets/       tray icon
 *
 * The two native-ish dependencies stay external: better-sqlite3 has a compiled
 * binary, and the Agent SDK resolves its own CLI and wasm files from disk.
 * Bundling either would break them.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const ROOT = join(DESKTOP, '..', '..');
const OUT = join(DESKTOP, 'build');

const production = process.argv.includes('--production');
const skipConsole = process.argv.includes('--skip-console');

const step = (m) => process.stdout.write(`\n▲ ${m}\n`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* 1 — the cockpit, exported to plain files ------------------------- */

if (!skipConsole) {
  step('exporting the console');
  const res = spawnSync('pnpm', ['--filter', '@helm/console', 'exec', 'next', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, HELM_TARGET: 'desktop' },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// With a custom distDir, `output: 'export'` writes the static site into that
// directory rather than into `out/`. Check both, and refuse to package a
// console that has no entry point rather than shipping a 404.
const CONSOLE = join(ROOT, 'apps', 'console');
const exported = [join(CONSOLE, '.next-desktop'), join(CONSOLE, 'out')].find((dir) =>
  existsSync(join(dir, 'index.html')),
);

if (!exported) {
  console.error(
    `\n✗ no exported console found — looked for index.html in:\n` +
      `    ${join(CONSOLE, '.next-desktop')}\n    ${join(CONSOLE, 'out')}\n`,
  );
  process.exit(1);
}
cpSync(exported, join(OUT, 'console'), { recursive: true });
process.stdout.write(`  exported console taken from ${exported}\n`);

/* 2 — the daemon, bundled ------------------------------------------ */

step('bundling the daemon');
await build({
  entryPoints: [join(ROOT, 'apps', 'bridge', 'src', 'index.ts')],
  outfile: join(OUT, 'bridge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
  banner: {
    // The daemon is ESM source using import.meta.url; give the CJS bundle an
    // equivalent so path resolution keeps working.
    js: "const __helm_url = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { 'import.meta.url': '__helm_url' },
  logLevel: 'info',
});

/* 3 — the Electron main process ------------------------------------ */

step('bundling the app shell');
await build({
  entryPoints: [join(DESKTOP, 'src', 'main.ts')],
  outfile: join(OUT, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});

/* 4 — files the daemon reads at runtime ---------------------------- */

step('copying migrations and assets');
cpSync(join(ROOT, 'apps', 'bridge', 'drizzle'), join(OUT, 'drizzle'), { recursive: true });

const assets = join(DESKTOP, 'assets');
if (!existsSync(join(assets, 'trayTemplate.png'))) {
  spawnSync(process.execPath, [join(HERE, 'make-icon.mjs')], { stdio: 'inherit' });
}
cpSync(assets, join(OUT, 'assets'), { recursive: true });

step(`done — ${production ? 'production' : 'development'} build in ${OUT}`);
