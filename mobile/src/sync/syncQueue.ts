/**
 * Push approved entries to the sheet and pull shared data. OWNER: data-layer builder.
 * Single-flight: concurrent calls share one in-progress sync.
 */
import { getSettings } from '../config/settings';
import { kvGet, kvSet } from '../db/database';
import { listUnsyncedLibrary, markLibraryItemsSynced, mergeLibraryFromSheet } from '../db/library';
import {
  clearPendingSheetDeletes,
  getMeal,
  listMeals,
  listPendingSheetDeletesWithKind,
  markMealsSynced,
  setMealStatus,
  type SheetDeleteKind,
} from '../db/meals';
import { getWeightEntry, listWeightEntries, markWeightsSynced, setWeightStatus } from '../db/weights';
import { isValidLocalDate, mondayOf, toLocalDate } from '../lib/dates';
import { errorMessage, logger } from '../lib/log';
import type { EntryStatus, MealEntry, WeightEntry } from '../types';
import type { SheetMealRow, SheetSummary, SheetWeightRow } from './contract';
import { libraryItemFromRow, libraryItemToRow, mealEntryToRow, weightEntryToRow } from './mapping';
import { getSheetInfo, getSheetsClient, refreshSheetInfo, SheetsApiError, type SheetsClient } from './sheetsClient';

export interface SyncResult {
  weightsSynced: number;
  mealsSynced: number;
  deletesSynced: number;
  libraryPushed: number;
  libraryPulled: number;
  errors: string[];
}

/** Rows per Apps Script request (keeps each call well inside its time limit). */
export const SYNC_BATCH_SIZE = 50;
const PENDING: EntryStatus[] = ['approved', 'sync_error'];
/** Statuses meaning "this entry should be in the sheet" — a queued delete for it is stale. */
const LIVE: EntryStatus[] = ['approved', 'synced', 'sync_error'];
const LAST_SYNC_KEY = 'lastSync';
const SUMMARY_KEY = 'summary';

const log = logger('sync');

interface SyncContext {
  client: SheetsClient;
  result: SyncResult;
  /** Set after an error that would repeat for every further request (offline, bad token…). */
  halted: boolean;
  /** Library ids whose sheet delete is still pending (must not be re-added by the pull). */
  pendingLibraryDeletes: Set<string>;
}

let inFlight: Promise<SyncResult> | null = null;

/**
 * 1) upsert approved/sync_error weight entries → synced (or sync_error with message)
 * 2) upsert approved/sync_error meals → synced
 * 3) delete meals queued via addPendingSheetDelete
 * 4) push unsynced library items, then pull the whole library (mergeLibraryFromSheet)
 * Batches of ≤ 50 rows per request.
 *
 * A failed batch marks its entries sync_error and the sync goes on, except after a
 * connection-level failure (network/timeout, unauthorized, bad response), where the
 * remaining requests are skipped because they would fail the same way.
 * Throws SheetsApiError('not_configured') when the sheet isn't connected.
 */
export async function syncNow(): Promise<SyncResult> {
  if (!inFlight) {
    inFlight = runSync().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** True while a sync is running. */
export function isSyncing(): boolean {
  return inFlight !== null;
}

async function runSync(): Promise<SyncResult> {
  const ctx: SyncContext = {
    client: await getSheetsClient(),
    result: { weightsSynced: 0, mealsSynced: 0, deletesSynced: 0, libraryPushed: 0, libraryPulled: 0, errors: [] },
    halted: false,
    pendingLibraryDeletes: new Set(),
  };
  await pushWeights(ctx);
  await pushMeals(ctx);
  await pushDeletes(ctx);
  await syncLibrary(ctx);
  await kvSet<LastSync>(LAST_SYNC_KEY, { ...ctx.result, at: Date.now() });
  if (ctx.result.errors.length) log.warn(`sync finished with ${ctx.result.errors.length} error(s)`);
  return ctx.result;
}

export interface LastSync extends SyncResult {
  at: number;
}

/** Result of the last completed sync (no network). */
export async function getLastSync(): Promise<LastSync | null> {
  return kvGet<LastSync>(LAST_SYNC_KEY);
}

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += SYNC_BATCH_SIZE) out.push(items.slice(i, i + SYNC_BATCH_SIZE));
  return out;
}

function isConnectionLevel(e: unknown): boolean {
  return (
    e instanceof SheetsApiError &&
    (e.code === 'network' || e.code === 'unauthorized' || e.code === 'bad_response' || e.code === 'not_configured')
  );
}

function recordFailure(ctx: SyncContext, what: string, e: unknown): string {
  const message = errorMessage(e);
  ctx.result.errors.push(`${what}: ${message}`);
  if (isConnectionLevel(e)) ctx.halted = true;
  return message;
}

/** Maps entries to rows; entries that can't be mapped are marked sync_error right away. */
async function toRows<E extends { id: string }, R>(
  entries: E[],
  map: (e: E) => R,
  markError: (id: string, message: string) => Promise<void>,
  ctx: SyncContext,
  what: string,
): Promise<{ entry: E; row: R }[]> {
  const ready: { entry: E; row: R }[] = [];
  for (const entry of entries) {
    try {
      ready.push({ entry, row: map(entry) });
    } catch (e) {
      const message = errorMessage(e);
      ctx.result.errors.push(`${what}: ${message}`);
      await markError(entry.id, message);
    }
  }
  return ready;
}

async function pushWeights(ctx: SyncContext): Promise<void> {
  const entries = await listWeightEntries({ statuses: PENDING });
  const markError = (id: string, m: string) => setWeightStatus(id, 'sync_error', m);
  const ready = await toRows<WeightEntry, SheetWeightRow>(entries, weightEntryToRow, markError, ctx, 'Weight Log');
  for (const batch of batches(ready)) {
    if (ctx.halted) return;
    try {
      await ctx.client.call('upsertWeights', { entries: batch.map((b) => b.row) });
      await markWeightsSynced(batch.map((b) => ({ id: b.entry.id, updatedAt: b.entry.updatedAt })));
      ctx.result.weightsSynced += batch.length;
    } catch (e) {
      const message = recordFailure(ctx, 'Weight Log', e);
      for (const b of batch) await markError(b.entry.id, message);
    }
  }
}

async function pushMeals(ctx: SyncContext): Promise<void> {
  const meals = await listMeals({ statuses: PENDING });
  const markError = (id: string, m: string) => setMealStatus(id, 'sync_error', m);
  const ready = await toRows<MealEntry, SheetMealRow>(meals, mealEntryToRow, markError, ctx, 'Food Log');
  for (const batch of batches(ready)) {
    if (ctx.halted) return;
    try {
      await ctx.client.call('upsertMeals', { entries: batch.map((b) => b.row) });
      await markMealsSynced(batch.map((b) => ({ id: b.entry.id, updatedAt: b.entry.updatedAt })));
      ctx.result.mealsSynced += batch.length;
    } catch (e) {
      const message = recordFailure(ctx, 'Food Log', e);
      for (const b of batch) await markError(b.entry.id, message);
    }
  }
}

/**
 * A queued weight/meal delete is stale when the entry was re-approved (it must stay in
 * the sheet). Library deletes never are: ids are never reused, and a local copy may just
 * be the pull re-adding a row whose delete failed earlier.
 */
async function stillLive(id: string, kind: SheetDeleteKind): Promise<boolean> {
  if (kind === 'weight') {
    const entry = await getWeightEntry(id);
    return entry !== null && LIVE.includes(entry.status);
  }
  if (kind === 'meal') {
    const meal = await getMeal(id);
    return meal !== null && LIVE.includes(meal.status);
  }
  return false;
}

async function pushDeletes(ctx: SyncContext): Promise<void> {
  const pending = await listPendingSheetDeletesWithKind();
  for (const p of pending) if (p.kind === 'library') ctx.pendingLibraryDeletes.add(p.id);
  if (ctx.halted) return;
  const stale: string[] = [];
  const byKind = new Map<SheetDeleteKind, string[]>();
  for (const { id, kind } of pending) {
    if (await stillLive(id, kind)) stale.push(id);
    else byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
  }
  if (stale.length) await clearPendingSheetDeletes(stale);

  for (const [kind, ids] of byKind) {
    for (const batch of batches(ids)) {
      if (ctx.halted) return;
      try {
        await ctx.client.call('deleteEntries', { kind, entryIds: batch });
        await clearPendingSheetDeletes(batch);
        ctx.result.deletesSynced += batch.length;
        if (kind === 'library') for (const id of batch) ctx.pendingLibraryDeletes.delete(id);
      } catch (e) {
        recordFailure(ctx, 'Delete', e);
      }
    }
  }
}

async function syncLibrary(ctx: SyncContext): Promise<void> {
  if (ctx.halted) return;
  const unsynced = await listUnsyncedLibrary();
  for (const batch of batches(unsynced)) {
    if (ctx.halted) return;
    try {
      await ctx.client.call('upsertLibrary', { items: batch.map(libraryItemToRow) });
      await markLibraryItemsSynced(batch.map((i) => ({ id: i.id, updatedAt: i.updatedAt })));
      ctx.result.libraryPushed += batch.length;
    } catch (e) {
      recordFailure(ctx, 'Food Library', e);
    }
  }
  if (ctx.halted) return;
  try {
    const { items } = await ctx.client.call('listLibrary', {});
    const pulled = items
      .map(libraryItemFromRow)
      .filter((i) => i.name && !ctx.pendingLibraryDeletes.has(i.id));
    // Unsynced local items that are newer survive the merge, so pulling after a failed push is safe.
    await mergeLibraryFromSheet(pulled);
    ctx.result.libraryPulled = pulled.length;
  } catch (e) {
    recordFailure(ctx, 'Food Library', e);
  }
}

// ---------------------------------------------------------------------------
// Summary (kv `summary`)
// ---------------------------------------------------------------------------

export interface CachedSummary extends SheetSummary {
  fetchedAt: number;
}

/**
 * Fetch getSummary for this phone's person for the plan to date; cache in kv `summary`.
 * Returns null when the phone has no person or sheet connection yet; throws
 * SheetsApiError on network/sheet errors (callers can fall back to getCachedSummary).
 */
export async function refreshSummary(): Promise<CachedSummary | null> {
  const settings = await getSettings();
  if (!settings.person) return null;
  let client: SheetsClient;
  try {
    client = await getSheetsClient();
  } catch (e) {
    if (e instanceof SheetsApiError && e.code === 'not_configured') return null;
    throw e;
  }
  const info = (await getSheetInfo()) ?? (await refreshSheetInfo());
  const today = toLocalDate(Date.now());
  const from = isValidLocalDate(info.startDate) ? info.startDate : mondayOf(today);
  const to = today < from ? from : today;
  const summary = await client.call('getSummary', { person: settings.person, from, to });
  const cached: CachedSummary = { ...summary, fetchedAt: Date.now() };
  await kvSet(SUMMARY_KEY, cached);
  return cached;
}

/** Last cached summary (no network); null if none or it belongs to another person. */
export async function getCachedSummary(): Promise<CachedSummary | null> {
  const [cached, settings] = await Promise.all([kvGet<CachedSummary>(SUMMARY_KEY), getSettings()]);
  if (!cached || cached.person !== settings.person) return null;
  return cached;
}
