/**
 * Foreground catch-up: when the app opens (or returns to the foreground) and the weekly or
 * daily run is due, process photos in the background of the UI and then push approved
 * entries. State is published for the small banner in the root layout.
 */
import { getSettings, updateSettings } from '../config/settings';
import { errorMessage, logger } from '../lib/log';
import { processPhotos } from '../pipeline/process';
import { dueAutoRun, isSheetConfigured } from '../scheduling/background';
import { isSyncing, syncNow } from '../sync/syncQueue';
import type { ProcessProgress, ProcessResult } from '../types';
import { shouldForegroundSync } from './autoRunPolicy';
import { runSummary } from './format';

export type AutoRunState =
  | { phase: 'idle' }
  | { phase: 'processing'; progress: ProcessProgress | null }
  | { phase: 'done'; message: string; hasNew: boolean }
  | { phase: 'error'; message: string };

const HIDE_DONE_MS = 6_000;
/** Review decisions made in a row (approve, approve, reject…) share one sync. */
export const SYNC_AFTER_REVIEW_MS = 3_000;
const HIDE_ERROR_MS = 10_000;
const log = logger('autoRun');

let state: AutoRunState = { phase: 'idle' };
const listeners = new Set<(s: AutoRunState) => void>();
let running: Promise<void> | null = null;
let lastSyncAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function publish(next: AutoRunState, hideAfterMs?: number): void {
  state = next;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = hideAfterMs ? setTimeout(() => publish({ phase: 'idle' }), hideAfterMs) : null;
  for (const l of [...listeners]) l(state);
}

export function getAutoRunState(): AutoRunState {
  return state;
}

export function subscribeAutoRun(listener: (s: AutoRunState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissAutoRun(): void {
  publish({ phase: 'idle' });
}

export interface ForegroundRunOptions {
  /** The current screen runs the pipeline itself (diced://process-week). */
  skipProcessing?: boolean;
}

/** Single-flight; never rejects. */
export function runDueWorkInForeground(opts: ForegroundRunOptions = {}): Promise<void> {
  if (!running) {
    running = catchUp(opts)
      .catch((e: unknown) => log.warn(`foreground run failed: ${errorMessage(e)}`))
      .finally(() => {
        running = null;
      });
  }
  return running;
}

async function catchUp(opts: ForegroundRunOptions): Promise<void> {
  const settings = await getSettings();
  if (!settings.onboardingComplete) return;
  const reason = opts.skipProcessing ? null : dueAutoRun(settings, Date.now());
  const result = reason ? await processDue(reason) : null;
  if (isSheetConfigured(settings) && shouldForegroundSync(lastSyncAt, Date.now(), result !== null)) {
    lastSyncAt = Date.now();
    await quietSync();
  }
}

async function processDue(reason: 'weekly' | 'daily'): Promise<ProcessResult | null> {
  publish({ phase: 'processing', progress: null });
  try {
    const result = await processPhotos({ reason, onProgress: (progress) => publish({ phase: 'processing', progress }) });
    // Like the background task: a run cut short stays due so the next opening resumes it.
    if (!result.partial) await updateSettings({ lastAutoRunAt: Date.now() });
    const hasNew = result.weightEntriesCreated + result.mealsCreated > 0;
    publish({ phase: 'done', message: runSummary(result), hasNew }, HIDE_DONE_MS);
    return result;
  } catch (e) {
    publish({ phase: 'error', message: `Couldn't process new photos: ${errorMessage(e)}` }, HIDE_ERROR_MS);
    return null;
  }
}

/**
 * Pushes review decisions (approve, reject, manual entries, edits of synced entries) to the
 * sheet a few seconds after the last one, so the other phone and the sheet see them without
 * waiting for the next foreground catch-up. Best-effort and never throws: failures show on the
 * entries as sync errors, and the next catch-up / background run retries.
 */
export function requestSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncAfterReview();
  }, SYNC_AFTER_REVIEW_MS);
}

async function syncAfterReview(): Promise<void> {
  try {
    if (!isSheetConfigured(await getSettings())) return;
    // A sync already running may have read the entries before this decision; run once more after it.
    if (isSyncing()) await syncNow().catch(() => undefined);
    lastSyncAt = Date.now();
    await quietSync();
  } catch (e) {
    log.warn(`sync after review failed: ${errorMessage(e)}`);
  }
}

/** Sync problems show up on the entries themselves (Review / Home), so no banner here. */
async function quietSync(): Promise<void> {
  try {
    const r = await syncNow();
    if (r.errors.length) log.warn(`foreground sync finished with ${r.errors.length} error(s)`);
  } catch (e) {
    log.warn(`foreground sync failed: ${errorMessage(e)}`);
  }
}
