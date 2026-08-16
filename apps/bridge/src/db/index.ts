import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHelmDirs, paths } from '../paths.js';
import * as schema from './schema.js';

export type HelmDb = BetterSQLite3Database<typeof schema>;

/**
 * Where the Drizzle migrations live.
 *
 * From source this is `apps/bridge/drizzle`, resolved relative to this file.
 * Inside a packaged desktop app the bridge is a single bundled file and the
 * migrations ship beside it, so the packager sets HELM_MIGRATIONS_DIR.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = process.env.HELM_MIGRATIONS_DIR
  ? resolve(process.env.HELM_MIGRATIONS_DIR)
  : join(here, '..', '..', 'drizzle');

let cached: { db: HelmDb; raw: Database.Database } | null = null;

export function openDb(file = paths.db): { db: HelmDb; raw: Database.Database } {
  ensureHelmDirs();
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  const db = drizzle(raw, { schema });
  if (existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  } else {
    throw new Error(
      `migrations folder missing at ${migrationsFolder} — run \`pnpm db:generate\``,
    );
  }
  return { db, raw };
}

export function getDb(): HelmDb {
  cached ??= openDb();
  return cached.db;
}

export function closeDb(): void {
  cached?.raw.close();
  cached = null;
}

export { schema };
