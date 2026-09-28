/** Food Library cache (table `library`). OWNER: data-layer builder. */
import type { LibraryItem } from '../types';
import { chunk, getDb, placeholders, withTransaction } from './database';
import { parseData } from './entryQuery';
import type { SQLiteDatabase } from 'expo-sqlite';

async function writeItem(db: SQLiteDatabase, item: LibraryItem): Promise<void> {
  await db.runAsync(
    `INSERT INTO library (id, name, synced, data, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, synced = excluded.synced, data = excluded.data, updated_at = excluded.updated_at`,
    item.id,
    item.name,
    item.synced ? 1 : 0,
    JSON.stringify(item),
    item.updatedAt,
  );
}

/** Alphabetical (case-insensitive). */
export async function listLibrary(): Promise<LibraryItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM library ORDER BY name COLLATE NOCASE, id');
  return rows.map((r) => parseData<LibraryItem>(r.data));
}

export async function getLibraryItem(id: string): Promise<LibraryItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM library WHERE id = ?', id);
  return row ? parseData<LibraryItem>(row.data) : null;
}

export async function upsertLibraryItem(item: LibraryItem): Promise<void> {
  const db = await getDb();
  await writeItem(db, item);
}

export interface LibraryMergePlan {
  upsert: LibraryItem[];
  remove: string[];
}

/**
 * Pure merge decision: sheet wins unless the local copy is unsynced and newer; local
 * items missing from the sheet survive only while unsynced (otherwise someone deleted
 * the row in the sheet).
 */
export function planLibraryMerge(local: LibraryItem[], sheet: LibraryItem[]): LibraryMergePlan {
  const localById = new Map(local.map((i) => [i.id, i]));
  const sheetIds = new Set<string>();
  const upsert: LibraryItem[] = [];
  for (const remote of sheet) {
    sheetIds.add(remote.id);
    const mine = localById.get(remote.id);
    if (mine && !mine.synced && mine.updatedAt > remote.updatedAt) continue;
    upsert.push({ ...remote, synced: true });
  }
  const remove = local.filter((i) => !sheetIds.has(i.id) && i.synced).map((i) => i.id);
  return { upsert, remove };
}

/**
 * Merge items fetched from the sheet: sheet wins unless the local copy is unsynced and
 * newer (updatedAt). Items missing from the sheet are kept only if unsynced.
 */
export async function mergeLibraryFromSheet(items: LibraryItem[]): Promise<void> {
  await withTransaction(async (db) => {
    const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM library');
    const plan = planLibraryMerge(
      rows.map((r) => parseData<LibraryItem>(r.data)),
      items,
    );
    for (const item of plan.upsert) await writeItem(db, item);
    for (const ids of chunk(plan.remove, 500)) {
      await db.runAsync(`DELETE FROM library WHERE id IN (${placeholders(ids.length)})`, ids);
    }
  });
}

/** Oldest change first. */
export async function listUnsyncedLibrary(): Promise<LibraryItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>(
    'SELECT data FROM library WHERE synced = 0 ORDER BY updated_at, id',
  );
  return rows.map((r) => parseData<LibraryItem>(r.data));
}

export async function markLibrarySynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  for (const batch of chunk(ids, 500)) {
    await db.runAsync(
      `UPDATE library SET synced = 1, data = json_set(data, '$.synced', json('true'))
       WHERE id IN (${placeholders(batch.length)})`,
      batch,
    );
  }
}

/** Like markLibrarySynced, but skips items changed since they were read (updatedAt differs). */
export async function markLibraryItemsSynced(items: { id: string; updatedAt: number }[]): Promise<number> {
  if (items.length === 0) return 0;
  return withTransaction(async (db) => {
    let marked = 0;
    for (const item of items) {
      const r = await db.runAsync(
        `UPDATE library SET synced = 1, data = json_set(data, '$.synced', json('true'))
         WHERE id = ? AND updated_at = ?`,
        item.id,
        item.updatedAt,
      );
      marked += r.changes;
    }
    return marked;
  });
}

/** uses + 1; the item becomes unsynced so the new count reaches the sheet. */
export async function incrementLibraryUse(id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `UPDATE library SET synced = 0, updated_at = ?,
       data = json_set(data,
         '$.uses', COALESCE(json_extract(data, '$.uses'), 0) + 1,
         '$.updatedAt', ?,
         '$.synced', json('false'))
     WHERE id = ?`,
    now,
    now,
    id,
  );
}

export async function deleteLibraryItem(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM library WHERE id = ?', id);
}
