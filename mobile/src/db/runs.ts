/** Processing run history (table `runs`). OWNER: data-layer builder. */
import type { ProcessResult } from '../types';
import { getDb } from './database';
import { parseData } from './entryQuery';

export interface RunRecord extends ProcessResult {
  id: number;
  startedAt: number;
  finishedAt: number;
}

/** History is only shown as "recent runs"; older rows are pruned. */
const KEEP_RUNS = 100;

export async function recordRun(startedAt: number, result: ProcessResult): Promise<void> {
  const db = await getDb();
  const { lastInsertRowId } = await db.runAsync(
    'INSERT INTO runs (started_at, finished_at, data) VALUES (?, ?, ?)',
    startedAt,
    Date.now(),
    JSON.stringify(result),
  );
  await db.runAsync('DELETE FROM runs WHERE id <= ?', lastInsertRowId - KEEP_RUNS);
}

/** Most recent first. */
export async function lastRuns(limit: number): Promise<RunRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: number; started_at: number; finished_at: number; data: string }>(
    'SELECT id, started_at, finished_at, data FROM runs ORDER BY id DESC LIMIT ?',
    Math.max(0, Math.floor(limit)),
  );
  return rows.map((r) => ({
    ...parseData<ProcessResult>(r.data),
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}
