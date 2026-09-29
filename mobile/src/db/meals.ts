/** Meal entries (table `meals`). OWNER: data-layer builder. */
import type { EntryStatus, LocalDate, MealEntry, PersonLabel } from '../types';
import { chunk, getDb, placeholders, withTransaction } from './database';
import { entryWhere, parseData, statusErrorParams } from './entryQuery';

export async function upsertMeal(meal: MealEntry): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO meals (id, person, local_date, time, status, data, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       person = excluded.person, local_date = excluded.local_date, time = excluded.time,
       status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
    meal.id,
    meal.person,
    meal.localDate,
    meal.time,
    meal.status,
    JSON.stringify(meal),
    meal.updatedAt,
  );
}

export async function getMeal(id: string): Promise<MealEntry | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM meals WHERE id = ?', id);
  return row ? parseData<MealEntry>(row.data) : null;
}

export interface MealFilter {
  person?: PersonLabel;
  statuses?: EntryStatus[];
  from?: LocalDate;
  to?: LocalDate;
}

/** Ordered by date desc, time asc. */
export async function listMeals(filter?: MealFilter): Promise<MealEntry[]> {
  const db = await getDb();
  const where = entryWhere(filter);
  const rows = await db.getAllAsync<{ data: string }>(
    `SELECT data FROM meals ${where.sql} ORDER BY local_date DESC, time ASC, id ASC`,
    where.params,
  );
  return rows.map((r) => parseData<MealEntry>(r.data));
}

/**
 * Sets status (and bumps updatedAt). `error` undefined → cleared, except that a
 * `sync_error` status keeps the previous message.
 */
export async function setMealStatus(id: string, status: EntryStatus, error?: string | null): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  const err = statusErrorParams(status, error);
  await db.runAsync(
    `UPDATE meals SET status = ?, updated_at = ?,
       data = json_set(data, '$.status', ?, '$.updatedAt', ?,
         '$.error', CASE WHEN ? = 1 THEN json_extract(data, '$.error') ELSE ? END)
     WHERE id = ?`,
    [status, now, status, now, err.keep, err.value, id],
  );
}

/**
 * Marks meals synced only if they were not edited since they were read for the sync
 * (same updatedAt), so an edit made mid-sync is pushed next time. Also records that the row is
 * in the sheet (`inSheet`), which outlives a later re-estimate / merge. Returns # marked.
 */
export async function markMealsSynced(meals: { id: string; updatedAt: number }[]): Promise<number> {
  if (meals.length === 0) return 0;
  return withTransaction(async (db) => {
    let marked = 0;
    for (const m of meals) {
      const r = await db.runAsync(
        `UPDATE meals SET status = 'synced',
           data = json_set(data, '$.status', 'synced', '$.error', NULL, '$.inSheet', json('true'))
         WHERE id = ? AND updated_at = ?`,
        m.id,
        m.updatedAt,
      );
      marked += r.changes;
    }
    return marked;
  });
}

/**
 * Marks meals sync_error with `message`, but only those not changed since they were read for the
 * sync (same updatedAt): a meal rejected or re-estimated while the request was in flight must keep
 * its new status, or the next sync would push it. Returns # marked.
 */
export async function markMealsSyncError(meals: { id: string; updatedAt: number }[], message: string): Promise<number> {
  if (meals.length === 0) return 0;
  return withTransaction(async (db) => {
    const now = Date.now();
    let marked = 0;
    for (const m of meals) {
      const r = await db.runAsync(
        `UPDATE meals SET status = 'sync_error', updated_at = ?,
           data = json_set(data, '$.status', 'sync_error', '$.updatedAt', ?, '$.error', ?)
         WHERE id = ? AND updated_at = ?`,
        now,
        now,
        message,
        m.id,
        m.updatedAt,
      );
      marked += r.changes;
    }
    return marked;
  });
}

export async function deleteMeal(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM meals WHERE id = ?', id);
}

// ---------------------------------------------------------------------------
// Sheet deletes queue (table `pending_sheet_deletes`, shared by all entry kinds)
// ---------------------------------------------------------------------------

export type SheetDeleteKind = 'weight' | 'meal' | 'library';

export interface PendingSheetDelete {
  id: string;
  kind: SheetDeleteKind;
}

/** Weight ids are deterministic (`w:<person>:<date>`); everything else defaults to a meal. */
export function inferDeleteKind(id: string): SheetDeleteKind {
  return id.startsWith('w:') ? 'weight' : 'meal';
}

/** Ids of meals deleted locally after they were synced (so sync can delete them in the sheet). */
export async function listPendingSheetDeletes(): Promise<string[]> {
  return (await listPendingSheetDeletesWithKind()).map((d) => d.id);
}

/** Every queued sheet delete with its kind (what syncNow uses). */
export async function listPendingSheetDeletesWithKind(): Promise<PendingSheetDelete[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; kind: string }>(
    'SELECT id, kind FROM pending_sheet_deletes ORDER BY kind, id',
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'weight' || r.kind === 'library' ? r.kind : 'meal',
  }));
}

/** Queue a sheet delete. `kind` defaults from the id (weight ids start with `w:`). */
export async function addPendingSheetDelete(id: string, kind: SheetDeleteKind = inferDeleteKind(id)): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO pending_sheet_deletes (id, kind) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
    id,
    kind,
  );
}

export async function clearPendingSheetDeletes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  for (const batch of chunk(ids, 500)) {
    await db.runAsync(`DELETE FROM pending_sheet_deletes WHERE id IN (${placeholders(batch.length)})`, batch);
  }
}
