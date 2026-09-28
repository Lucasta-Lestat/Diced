/** Weight entries (table `weight_entries`). OWNER: data-layer builder. */
import { addDays } from '../lib/dates';
import type { EntryStatus, LocalDate, PersonLabel, WeightEntry } from '../types';
import { getDb, withTransaction } from './database';
import { entryWhere, parseData, statusErrorParams } from './entryQuery';

export async function upsertWeightEntry(entry: WeightEntry): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO weight_entries (id, person, local_date, status, data, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       person = excluded.person, local_date = excluded.local_date, status = excluded.status,
       data = excluded.data, updated_at = excluded.updated_at`,
    entry.id,
    entry.person,
    entry.localDate,
    entry.status,
    JSON.stringify(entry),
    entry.updatedAt,
  );
}

export async function getWeightEntry(id: string): Promise<WeightEntry | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM weight_entries WHERE id = ?', id);
  return row ? parseData<WeightEntry>(row.data) : null;
}

export interface WeightFilter {
  person?: PersonLabel;
  statuses?: EntryStatus[];
  from?: LocalDate;
  to?: LocalDate;
}

/** Newest date first. */
export async function listWeightEntries(filter?: WeightFilter): Promise<WeightEntry[]> {
  const db = await getDb();
  const where = entryWhere(filter);
  const rows = await db.getAllAsync<{ data: string }>(
    `SELECT data FROM weight_entries ${where.sql} ORDER BY local_date DESC, person ASC`,
    where.params,
  );
  return rows.map((r) => parseData<WeightEntry>(r.data));
}

/**
 * Accepted weights (status approved | synced) for `person` in the `days` days before
 * `beforeDate` (exclusive), newest first — used for trend plausibility checks.
 */
export async function recentAcceptedWeights(
  person: PersonLabel,
  beforeDate: LocalDate,
  days: number,
): Promise<WeightEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>(
    `SELECT data FROM weight_entries
     WHERE person = ? AND status IN ('approved', 'synced') AND local_date >= ? AND local_date < ?
     ORDER BY local_date DESC`,
    person,
    addDays(beforeDate, -days),
    beforeDate,
  );
  return rows.map((r) => parseData<WeightEntry>(r.data));
}

/**
 * Sets status (and bumps updatedAt). `syncError` undefined → cleared, except that a
 * `sync_error` status keeps the previous message.
 */
export async function setWeightStatus(
  id: string,
  status: EntryStatus,
  syncError?: string | null,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  const err = statusErrorParams(status, syncError);
  await db.runAsync(
    `UPDATE weight_entries SET status = ?, updated_at = ?,
       data = json_set(data, '$.status', ?, '$.updatedAt', ?,
         '$.syncError', CASE WHEN ? = 1 THEN json_extract(data, '$.syncError') ELSE ? END)
     WHERE id = ?`,
    [status, now, status, now, err.keep, err.value, id],
  );
}

/**
 * Marks entries synced only if they were not edited since they were read for the sync
 * (same updatedAt), so an edit made mid-sync is pushed next time. Returns # marked.
 */
export async function markWeightsSynced(entries: { id: string; updatedAt: number }[]): Promise<number> {
  if (entries.length === 0) return 0;
  return withTransaction(async (db) => {
    let marked = 0;
    for (const e of entries) {
      const r = await db.runAsync(
        `UPDATE weight_entries SET status = 'synced',
           data = json_set(data, '$.status', 'synced', '$.syncError', NULL)
         WHERE id = ? AND updated_at = ?`,
        e.id,
        e.updatedAt,
      );
      marked += r.changes;
    }
    return marked;
  });
}

export async function deleteWeightEntry(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM weight_entries WHERE id = ?', id);
}
