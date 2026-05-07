import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

const FILE_MODE_RW_OWNER_ONLY = 0o600;
const DIR_MODE_RWX_OWNER_ONLY = 0o700;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function ensureParentDirectory(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE_RWX_OWNER_ONLY });
  }
}

function applyPragmas(sqlite: BetterSqlite3.Database): void {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
}

export function openDatabase(path: string): Db {
  const isMemory = path === ':memory:';
  const isNew = !isMemory && !existsSync(path);
  if (!isMemory) ensureParentDirectory(path);
  const sqlite = new BetterSqlite3(path);
  applyPragmas(sqlite);
  if (isNew) chmodSync(path, FILE_MODE_RW_OWNER_ONLY);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
