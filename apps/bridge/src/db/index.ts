import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHelmDirs, paths } from '../paths.js';
import * as schema from './schema.js';

export type HelmDb = BetterSQLite3Database<typeof schema>;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'drizzle');

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
