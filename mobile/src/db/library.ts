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
 * the row in the sheet). The use count always comes from the sheet (both phones add to it),
 * and uses this phone hasn't pushed yet (`pendingUses`) are kept on top of it.
 */
export function planLibraryMerge(local: LibraryItem[], sheet: LibraryItem[]): LibraryMergePlan {
  const localById = new Map(local.map((i) => [i.id, i]));
  const sheetIds = new Set<string>();
  const upsert: LibraryItem[] = [];
  for (const remote of sheet) {
    sheetIds.add(remote.id);
    const mine = localById.get(remote.id);
    if (mine && !mine.synced && mine.updatedAt > remote.updatedAt) {
      // This phone's edit is newer: keep it, but count the uses the sheet has.
      if (mine.uses !== remote.uses) upsert.push({ ...mine, uses: remote.uses });
      continue;
    }
    const pending = mine?.pendingUses ? { pendingUses: mine.pendingUses } : {};
    upsert.push({ ...remote, synced: true, ...pending });
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

/** Items to push: unsynced content or uses not yet added to the sheet's count. Oldest change first. */
export async function listUnsyncedLibrary(): Promise<LibraryItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>(
    `SELECT data FROM library
     WHERE synced = 0 OR COALESCE(json_extract(data, '$.pendingUses'), 0) > 0
     ORDER BY updated_at, id`,
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

/**
 * After a push: the `pendingUses` that were sent (pushed as part of the sheet's count) move into
 * `uses`, and items not changed since they were read (same updatedAt) are marked synced. Returns
 * # marked synced.
 */
export async function markLibraryItemsSynced(
  items: { id: string; updatedAt: number; pendingUses?: number }[],
): Promise<number> {
  if (items.length === 0) return 0;
  return withTransaction(async (db) => {
    let marked = 0;
    for (const item of items) {
      const sent = item.pendingUses ?? 0;
      if (sent > 0) {
        // Uses counted while the request was in flight stay pending.
        await db.runAsync(
          `UPDATE library SET data = CASE
             WHEN COALESCE(json_extract(data, '$.pendingUses'), 0) - ? > 0
               THEN json_set(data, '$.uses', COALESCE(json_extract(data, '$.uses'), 0) + ?,
                                   '$.pendingUses', COALESCE(json_extract(data, '$.pendingUses'), 0) - ?)
             ELSE json_remove(json_set(data, '$.uses', COALESCE(json_extract(data, '$.uses'), 0) + ?), '$.pendingUses')
           END
           WHERE id = ?`,
          sent,
          sent,
          sent,
          sent,
          item.id,
        );
      }
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

/**
 * One more use, counted as pending: the next sync adds it to the sheet's count. The item's content
 * and updatedAt are untouched, so a stale local copy never looks newer than an edit made on the
 * other phone (which would overwrite it).
 */
export async function incrementLibraryUse(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE library SET data = json_set(data, '$.pendingUses', COALESCE(json_extract(data, '$.pendingUses'), 0) + 1)
     WHERE id = ?`,
    id,
  );
}

export async function deleteLibraryItem(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM library WHERE id = ?', id);
}
