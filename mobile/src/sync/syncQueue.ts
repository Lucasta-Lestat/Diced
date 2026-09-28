/**
 * Push approved entries to the sheet and pull shared data. OWNER: data-layer builder.
 * Single-flight: concurrent calls share one in-progress sync.
 */
import type { SheetSummary } from './contract';

export interface SyncResult {
  weightsSynced: number;
  mealsSynced: number;
  deletesSynced: number;
  libraryPushed: number;
  libraryPulled: number;
  errors: string[];
}

/**
 * 1) upsert approved/sync_error weight entries → synced (or sync_error with message)
 * 2) upsert approved/sync_error meals → synced
 * 3) delete meals queued via addPendingSheetDelete
 * 4) push unsynced library items, then pull the whole library (mergeLibraryFromSheet)
 * Batches of ≤ 50 rows per request.
 */
export async function syncNow(): Promise<SyncResult> {
  throw new Error('not implemented');
}

/** Fetch getSummary for this phone's person for the plan to date; cache in kv `summary`. */
export async function refreshSummary(): Promise<SheetSummary | null> {
  throw new Error('not implemented');
}

/** Last cached summary (no network). */
export async function getCachedSummary(): Promise<SheetSummary | null> {
  throw new Error('not implemented');
}
