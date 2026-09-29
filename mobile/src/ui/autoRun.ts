/**
 * Foreground catch-up: when the app opens (or returns to the foreground) and the weekly or
 * daily run is due, process photos in the background of the UI and then push approved
 * entries. State is published for the small banner in the root layout.
 *
 * Also owns the UI's shared pipeline run: `processPhotos` is single-flight and ignores a joining
 * caller's `signal` / `onProgress`, so every UI caller (this catch-up, the process-week screen)
 * starts or joins the run through `startSharedRun`, which keeps one AbortController and one
 * progress stream per run. Any screen can then cancel or watch whichever run is active.
 */
import { getSettings, updateSettings } from '../config/settings';
import { errorMessage, logger } from '../lib/log';
import { processPhotos } from '../pipeline/process';
import { dueAutoRun, isSheetConfigured } from '../scheduling/background';
import { isSyncing, syncNow } from '../sync/syncQueue';
import type { ProcessProgress, ProcessResult, RunReason } from '../types';
import { shouldForegroundSync } from './autoRunPolicy';
import { runSummary } from './format';

export type AutoRunState =
  | { phase: 'idle' }
  /** `hidden`: the user dismissed the banner; processing continues and progress still updates. */
  | { phase: 'processing'; progress: ProcessProgress | null; hidden: boolean }
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

/**
 * Hides the banner. While processing, the run keeps going and the banner stays hidden until it
 * finishes (the done / error message is shown again).
 */
export function dismissAutoRun(): void {
  if (state.phase === 'processing') publish({ ...state, hidden: true });
  else publish({ phase: 'idle' });
}

// ---------------------------------------------------------------------------
// Shared UI run
// ---------------------------------------------------------------------------

interface SharedRun {
  controller: AbortController;
  progress: ProcessProgress | null;
  promise: Promise<ProcessResult>;
}

export interface UiRunSnapshot {
  /** The in-flight shared run's promise, or null when none is running. */
  promise: Promise<ProcessResult> | null;
  progress: ProcessProgress | null;
}

let sharedRun: SharedRun | null = null;
let runSnapshot: UiRunSnapshot = { promise: null, progress: null };
const runListeners = new Set<() => void>();
/** Screens that own a run right now (checking permission, then following it). */
let screenHolds = 0;

function emitRun(): void {
  runSnapshot = { promise: sharedRun?.promise ?? null, progress: sharedRun?.progress ?? null };
  for (const l of [...runListeners]) l();
}

/** Stable snapshot for useSyncExternalStore (a new object only when something changed). */
export function getUiRunSnapshot(): UiRunSnapshot {
  return runSnapshot;
}

export function subscribeUiRun(listener: () => void): () => void {
  runListeners.add(listener);
  return () => {
    runListeners.delete(listener);
  };
}

/** Starts a pipeline run, or joins the one the UI already started (its `reason` then wins). */
export function startSharedRun(reason: RunReason): Promise<ProcessResult> {
  if (sharedRun) return sharedRun.promise;
  const controller = new AbortController();
  const holder: { run: SharedRun | null } = { run: null };
  const promise = processPhotos({
    reason,
    signal: controller.signal,
    onProgress: (progress) => {
      if (!holder.run) return;
      holder.run.progress = progress;
      if (sharedRun === holder.run) emitRun();
    },
  }).finally(() => {
    if (sharedRun === holder.run) {
      sharedRun = null;
      emitRun();
    }
  });
  holder.run = { controller, progress: null, promise };
  sharedRun = holder.run;
  emitRun();
  return promise;
}

/** Asks the shared run to stop after the current photo; false when none is running. */
export function cancelSharedRun(): boolean {
  if (!sharedRun) return false;
  sharedRun.controller.abort();
  return true;
}

/**
 * A screen that runs the pipeline itself (diced://process-week) holds this from the moment it
 * starts until its run finishes, so the foreground catch-up doesn't start a second run of its own.
 * Taken synchronously in the screen's effect, which runs before the root layout's catch-up effect.
 */
export function holdScreenRun(): () => void {
  screenHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    screenHolds -= 1;
  };
}

// ---------------------------------------------------------------------------
// Foreground catch-up
// ---------------------------------------------------------------------------

export interface ForegroundRunOptions {
  /** Don't process photos, only sync (processing is handled elsewhere). */
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
  // Only a screen that is actually running (not one idling on its result) keeps the catch-up out.
  const skip = opts.skipProcessing || screenHolds > 0 || sharedRun !== null;
  const reason = skip ? null : dueAutoRun(settings, Date.now());
  const result = reason ? await processDue(reason) : null;
  if (isSheetConfigured(settings) && shouldForegroundSync(lastSyncAt, Date.now(), result !== null)) {
    lastSyncAt = Date.now();
    await quietSync();
  }
}

async function processDue(reason: 'weekly' | 'daily'): Promise<ProcessResult | null> {
  publish({ phase: 'processing', progress: null, hidden: false });
  const unsubscribe = subscribeUiRun(() => {
    if (state.phase === 'processing' && runSnapshot.promise) publish({ ...state, progress: runSnapshot.progress });
  });
  try {
    const result = await startSharedRun(reason);
    // Like the background task: a run cut short stays due so the next opening resumes it.
    if (!result.partial) await updateSettings({ lastAutoRunAt: Date.now() });
    const hasNew = result.weightEntriesCreated + result.mealsCreated > 0;
    publish({ phase: 'done', message: runSummary(result), hasNew }, HIDE_DONE_MS);
    return result;
  } catch (e) {
    publish({ phase: 'error', message: `Couldn't process new photos: ${errorMessage(e)}` }, HIDE_ERROR_MS);
    return null;
  } finally {
    unsubscribe();
  }
}

// ---------------------------------------------------------------------------
// Sync after review
// ---------------------------------------------------------------------------

const syncListeners = new Set<() => void>();

/** Called after every background sync from here (success or not), so screens can reload. */
export function subscribeSyncDone(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => {
    syncListeners.delete(listener);
  };
}

function emitSyncDone(): void {
  for (const l of [...syncListeners]) l();
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

/**
 * Sync problems show up on the entries themselves (Review / Home), so no banner here; screens
 * that list entries reload via subscribeSyncDone.
 */
async function quietSync(): Promise<void> {
  try {
    const r = await syncNow();
    if (r.errors.length) log.warn(`foreground sync finished with ${r.errors.length} error(s)`);
  } catch (e) {
    log.warn(`foreground sync failed: ${errorMessage(e)}`);
  } finally {
    emitSyncDone();
  }
}

/** Test-only: forget module state between tests. */
export function __resetAutoRunForTests(): void {
  state = { phase: 'idle' };
  listeners.clear();
  running = null;
  lastSyncAt = 0;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  sharedRun = null;
  runSnapshot = { promise: null, progress: null };
  runListeners.clear();
  screenHolds = 0;
  syncListeners.clear();
}
