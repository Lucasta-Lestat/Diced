/**
 * SQLite (expo-sqlite) connection + schema migrations. OWNER: data-layer builder.
 * Tables: kv, photos, weight_entries, meals, pending_sheet_deletes, library, runs.
 * Whole domain objects live in a JSON `data` column; the other columns are copies of
 * the fields we filter/sort on and are always written together with `data`.
 */
import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

const DB_NAME = 'diced.db';

/**
 * Migration N (index N-1) upgrades a database from user_version N-1 to N.
 * Append new migrations; never edit a shipped one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS photos (
    asset_id TEXT PRIMARY KEY NOT NULL,
    uri TEXT NOT NULL,
    creation_time INTEGER NOT NULL,
    local_date TEXT NOT NULL,
    origin TEXT NOT NULL,
    excluded_reason TEXT,
    category TEXT,
    category_confidence REAL,
    classified_at INTEGER,
    processed_at INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS photos_creation_time ON photos (creation_time);

  CREATE TABLE IF NOT EXISTS weight_entries (
    id TEXT PRIMARY KEY NOT NULL,
    person TEXT NOT NULL,
    local_date TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS weight_entries_person_date ON weight_entries (person, local_date);

  CREATE TABLE IF NOT EXISTS meals (
    id TEXT PRIMARY KEY NOT NULL,
    person TEXT NOT NULL,
    local_date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meals_person_date ON meals (person, local_date);
  CREATE INDEX IF NOT EXISTS meals_status ON meals (status);

  CREATE TABLE IF NOT EXISTS pending_sheet_deletes (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  `,
];

let dbPromise: Promise<SQLiteDatabase> | null = null;

/** Open (once) and migrate the database `diced.db`. Safe to call many times. */
export async function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndMigrate().catch((e: unknown) => {
      // Let the next caller retry instead of caching a rejected promise forever.
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  await migrate(db);
  return db;
}

/** Runs every migration above the database's `user_version`, each in its own transaction. */
export async function migrate(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    // No other query can run yet (getDb callers wait for this), so the non-exclusive
    // transaction is safe here.
    await db.withTransactionAsync(async () => {
      await db.execAsync(MIGRATIONS[version]);
      await db.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

let txnChain: Promise<unknown> = Promise.resolve();

/**
 * Serialized transaction on the shared connection. expo-sqlite's `withTransactionAsync`
 * fails if another BEGIN is already open on the connection, so every multi-statement
 * write in the data layer goes through this queue.
 */
export function withTransaction<T>(task: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const db = await getDb();
    let result!: T;
    await db.withTransactionAsync(async () => {
      result = await task(db);
    });
    return result;
  };
  const next = txnChain.then(run, run);
  txnChain = next.catch(() => undefined);
  return next;
}

/** Generic key/value helpers backed by the `kv` table (JSON-encoded values). */
export async function kvGet<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export async function kvDelete(key: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM kv WHERE key = ?', key);
}

/** `?, ?, ?` for an IN (...) list. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Split `items` into chunks of at most `size` (bound-parameter limits, sheet batches). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Test-only: forget the memoized connection. */
export function __resetDbForTests(): void {
  dbPromise = null;
  txnChain = Promise.resolve();
}
