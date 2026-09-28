/**
 * Background processing via expo-background-task + expo-task-manager. OWNER: photos/scheduling builder.
 * `defineBackgroundTask()` must run at module scope of the app entry (src/scheduling/defineTasks.ts,
 * imported first by index.ts).
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { getSettings, updateSettings } from '../config/settings';
import { errorMessage, logger } from '../lib/log';
import type { AppSettings } from '../types';
import { isDailyRunDue, isWeeklyRunDue } from './due';
import { notifyReviewReady } from './notifications';

export const BACKGROUND_TASK = 'diced-background-processing';
/** expo-background-task takes minutes. */
export const BACKGROUND_MIN_INTERVAL_MINUTES = 12 * 60;
/** iOS gives a BGProcessingTask little time before expiring it; WorkManager allows ~10 min. */
const IOS_TIME_BUDGET_MS = 25_000;
const ANDROID_TIME_BUDGET_MS = 8 * 60_000;

const log = logger('background');

/** Sheet connected and a person picked — nothing can be written anywhere otherwise. */
export function isSheetConfigured(settings: AppSettings): boolean {
  return Boolean(settings.person && settings.sheetWebAppUrl);
}

/** Which automatic run is due now (weekly wins), or null. Manual mode never scans on its own. */
export function dueAutoRun(settings: AppSettings, now: number): 'weekly' | 'daily' | null {
  if (!isSheetConfigured(settings) || settings.classificationMode !== 'cloud_thumbnails') return null;
  if (isWeeklyRunDue(settings, now)) return 'weekly';
  if (isDailyRunDue(settings, now)) return 'daily';
  return null;
}

function timeBudgetMs(): number {
  return Platform.OS === 'ios' ? IOS_TIME_BUDGET_MS : ANDROID_TIME_BUDGET_MS;
}

/** iOS warns before killing the task; stop starting new work so per-photo state is saved. */
function onExpiration(abort: () => void): { remove: () => void } | null {
  if (Platform.OS !== 'ios') return null;
  try {
    return BackgroundTask.addExpirationListener(abort);
  } catch {
    return null;
  }
}

// Required lazily: the pipeline imports scheduling modules (a cycle at module scope), and the
// task must stay cheap to define at app start. Inline require works in Metro and Jest alike.
function loadPipeline(): typeof import('../pipeline/process') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose, see above
  return require('../pipeline/process');
}

function loadSyncQueue(): typeof import('../sync/syncQueue') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose, see above
  return require('../sync/syncQueue');
}

async function processDueRun(reason: 'weekly' | 'daily'): Promise<boolean> {
  const controller = new AbortController();
  const expiration = onExpiration(() => controller.abort());
  try {
    const { processPhotos } = loadPipeline();
    const result = await processPhotos({ reason, timeBudgetMs: timeBudgetMs(), signal: controller.signal });
    // A run cut short by the budget isn't finished: leave it due so the next wake-up resumes it.
    if (!result.partial) await updateSettings({ lastAutoRunAt: Date.now() });
    await notifyQuietly(result.weightEntriesCreated, result.mealsCreated);
    return true;
  } catch (e) {
    log.error(`${reason} run failed: ${errorMessage(e)}`);
    return false;
  } finally {
    expiration?.remove();
  }
}

/** A missing notification permission must not turn a successful run into a failed one. */
async function notifyQuietly(weights: number, meals: number): Promise<void> {
  try {
    await notifyReviewReady(weights, meals);
  } catch (e) {
    log.warn(`could not post review notification: ${errorMessage(e)}`);
  }
}

/** Push entries the user already approved (e.g. approved while offline). */
async function syncApproved(): Promise<boolean> {
  try {
    const { syncNow } = loadSyncQueue();
    const result = await syncNow();
    if (result.errors.length > 0) log.warn(`sync finished with ${result.errors.length} error(s)`);
    return true;
  } catch (e) {
    log.warn(`sync failed: ${errorMessage(e)}`);
    return false;
  }
}

/** The task body. Never throws: errors become BackgroundTaskResult.Failed. */
export async function runBackgroundTask(): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    const settings = await getSettings();
    if (!isSheetConfigured(settings)) return BackgroundTask.BackgroundTaskResult.Success;
    const reason = dueAutoRun(settings, Date.now());
    const processed = reason ? await processDueRun(reason) : true;
    const synced = await syncApproved();
    return processed && synced ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch (e) {
    log.error(`background task failed: ${errorMessage(e)}`);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

/** TaskManager.defineTask for BACKGROUND_TASK: if weekly/daily run is due → processPhotos with a time budget → notify. */
export function defineBackgroundTask(): void {
  if (TaskManager.isTaskDefined(BACKGROUND_TASK)) return;
  TaskManager.defineTask(BACKGROUND_TASK, async ({ error }) => {
    if (error) {
      log.error(`background task error: ${error.message}`);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
    return runBackgroundTask();
  });
}

/** Register (idempotent) with a minimum interval of 12 h. No-op when unavailable (e.g. Expo Go/web). */
export async function registerBackgroundTask(): Promise<void> {
  try {
    if ((await backgroundTaskStatus()) !== 'available') return;
    defineBackgroundTask();
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK)) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_TASK, { minimumInterval: BACKGROUND_MIN_INTERVAL_MINUTES });
  } catch (e) {
    log.warn(`could not register background task: ${errorMessage(e)}`);
  }
}

export async function unregisterBackgroundTask(): Promise<void> {
  try {
    if (!(await TaskManager.isAvailableAsync())) return;
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_TASK);
  } catch (e) {
    log.warn(`could not unregister background task: ${errorMessage(e)}`);
  }
}

export async function backgroundTaskStatus(): Promise<'available' | 'restricted' | 'unavailable'> {
  try {
    if (!(await TaskManager.isAvailableAsync())) return 'unavailable';
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Available) return 'available';
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return 'restricted';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
