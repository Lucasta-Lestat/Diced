/**
 * SQLite (expo-sqlite) connection + schema migrations. OWNER: data-layer builder.
 * Tables: kv, photos, weight_entries, meals, library, runs. JSON columns for arrays/objects.
 */
import type { SQLiteDatabase } from 'expo-sqlite';

/** Open (once) and migrate the database `diced.db`. Safe to call many times. */
export async function getDb(): Promise<SQLiteDatabase> {
  throw new Error('not implemented');
}

/** Generic key/value helpers backed by the `kv` table (JSON-encoded values). */
export async function kvGet<T>(key: string): Promise<T | null> {
  throw new Error('not implemented');
}
export async function kvSet<T>(key: string, value: T): Promise<void> {
  throw new Error('not implemented');
}
