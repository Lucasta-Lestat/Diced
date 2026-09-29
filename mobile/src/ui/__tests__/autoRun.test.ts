/// <reference types="jest" />
import { getSettings, updateSettings } from '../../config/settings';
import { processPhotos } from '../../pipeline/process';
import { dueAutoRun } from '../../scheduling/background';
import { isSyncing, syncNow } from '../../sync/syncQueue';
import type { ProcessOptions } from '../../pipeline/process';
import type { ProcessProgress, ProcessResult } from '../../types';
import {
  __resetAutoRunForTests,
  cancelSharedRun,
  dismissAutoRun,
  getAutoRunState,
  getUiRunSnapshot,
  holdScreenRun,
  requestSync,
  runDueWorkInForeground,
  startSharedRun,
  subscribeSyncDone,
  SYNC_AFTER_REVIEW_MS,
} from '../autoRun';

jest.mock('../../config/settings', () => ({
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
}));
jest.mock('../../pipeline/process', () => ({ processPhotos: jest.fn() }));
jest.mock('../../sync/syncQueue', () => ({ isSyncing: jest.fn(), syncNow: jest.fn() }));
jest.mock('../../scheduling/background', () => ({
  dueAutoRun: jest.fn(() => null),
  isSheetConfigured: (s: { person: string | null; sheetWebAppUrl: string | null }) => Boolean(s.person && s.sheetWebAppUrl),
}));

const mockGetSettings = getSettings as jest.Mock;
const mockUpdateSettings = updateSettings as jest.Mock;
const mockProcessPhotos = processPhotos as jest.Mock;
const mockDueAutoRun = dueAutoRun as jest.Mock;
const mockSyncNow = syncNow as jest.Mock;
const mockIsSyncing = isSyncing as jest.Mock;

const EMPTY = { weightsSynced: 0, mealsSynced: 0, deletesSynced: 0, libraryPushed: 0, libraryPulled: 0, errors: [] };

/** Lets the timer callback's promise chain run to the end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  __resetAutoRunForTests();
  mockDueAutoRun.mockReturnValue(null);
  mockGetSettings.mockResolvedValue({ person: 'Her', sheetWebAppUrl: 'https://script.google.com/macros/s/x/exec' });
  mockSyncNow.mockResolvedValue(EMPTY);
  mockIsSyncing.mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
});

test('decisions made in a row share one sync, sent after the quiet period', async () => {
  requestSync();
  jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS - 1);
  requestSync();
  requestSync();
  jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS - 1);
  await flush();
  expect(mockSyncNow).not.toHaveBeenCalled();

  jest.advanceTimersByTime(1);
  await flush();
  expect(mockSyncNow).toHaveBeenCalledTimes(1);
});

test('does nothing until the sheet is connected', async () => {
  mockGetSettings.mockResolvedValue({ person: 'Her', sheetWebAppUrl: null });
  requestSync();
  jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS);
  await flush();
  expect(mockSyncNow).not.toHaveBeenCalled();
});

test('a sync already in flight is followed by a fresh one (it may have missed the decision)', async () => {
  mockIsSyncing.mockReturnValue(true);
  requestSync();
  jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS);
  await flush();
  expect(mockSyncNow).toHaveBeenCalledTimes(2);
});

test('never throws when the sync fails (the failure is only logged)', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockSyncNow.mockRejectedValue(new Error('offline'));
  requestSync();
  jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS);
  await flush();
  expect(mockSyncNow).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls.flat().join(' ')).toMatch(/sync failed: offline/);
  warn.mockRestore();
});

const RESULT: ProcessResult = {
  reason: 'weekly',
  windowStart: 0,
  windowEnd: 1,
  photosScanned: 4,
  photosExcluded: 0,
  photosClassified: 4,
  scalePhotos: 1,
  foodPhotos: 2,
  weightEntriesCreated: 1,
  mealsCreated: 1,
  errors: [],
  partial: false,
};

/** processPhotos stand-in that stays running until `finish` is called, like the real single-flight run. */
function controllableRun() {
  let resolve: (r: ProcessResult) => void = () => undefined;
  let opts: ProcessOptions | null = null;
  mockProcessPhotos.mockImplementation((o: ProcessOptions) => {
    opts = o;
    return new Promise<ProcessResult>((r) => {
      resolve = r;
    });
  });
  return {
    options: () => opts,
    progress: (p: ProcessProgress) => opts?.onProgress?.(p),
    finish: (r: Partial<ProcessResult> = {}) => resolve({ ...RESULT, partial: Boolean(opts?.signal?.aborted), ...r }),
  };
}

const PROGRESS: ProcessProgress = { stage: 'estimating_meals', done: 2, total: 5, message: '' };

describe('shared UI run', () => {
  test('a second caller joins the running pipeline instead of starting another', async () => {
    const run = controllableRun();
    const first = startSharedRun('weekly');
    const second = startSharedRun('deeplink');
    expect(second).toBe(first);
    expect(mockProcessPhotos).toHaveBeenCalledTimes(1);
    run.finish();
    await expect(second).resolves.toMatchObject({ mealsCreated: 1 });
    expect(getUiRunSnapshot().promise).toBeNull();
  });

  test('cancel reaches the pipeline even for a screen that joined someone else’s run', async () => {
    const run = controllableRun();
    void startSharedRun('weekly'); // e.g. the foreground catch-up
    const joined = startSharedRun('deeplink'); // process-week
    expect(cancelSharedRun()).toBe(true);
    expect(run.options()?.signal?.aborted).toBe(true);
    run.finish();
    await expect(joined).resolves.toMatchObject({ partial: true });
    expect(cancelSharedRun()).toBe(false);
  });

  test('progress is published to every viewer, including one that joins later', () => {
    const run = controllableRun();
    void startSharedRun('weekly');
    run.progress(PROGRESS);
    // A viewer arriving now (a newly opened process-week) sees the latest progress right away.
    expect(getUiRunSnapshot().progress).toEqual(PROGRESS);
    run.finish();
  });
});

describe('foreground catch-up', () => {
  beforeEach(() => {
    mockGetSettings.mockResolvedValue({ person: 'Her', sheetWebAppUrl: 'https://script.google.com/macros/s/x/exec', onboardingComplete: true });
    mockDueAutoRun.mockReturnValue('weekly');
    mockUpdateSettings.mockResolvedValue(undefined);
  });

  test('processes when due, even while the process-week screen is merely showing an old result', async () => {
    mockProcessPhotos.mockResolvedValue(RESULT);
    await runDueWorkInForeground();
    expect(mockProcessPhotos).toHaveBeenCalledWith(expect.objectContaining({ reason: 'weekly' }));
    expect(getAutoRunState()).toMatchObject({ phase: 'done', hasNew: true });
  });

  test('stays out of the way while a screen owns a run', async () => {
    const release = holdScreenRun();
    await runDueWorkInForeground();
    expect(mockProcessPhotos).not.toHaveBeenCalled();
    release();
    release(); // releasing twice is harmless
    mockProcessPhotos.mockResolvedValue(RESULT);
    await runDueWorkInForeground();
    expect(mockProcessPhotos).toHaveBeenCalledTimes(1);
  });

  test('a dismissed processing banner stays hidden while progress keeps coming, then shows the result', async () => {
    const run = controllableRun();
    const done = runDueWorkInForeground();
    await flush();
    expect(getAutoRunState()).toMatchObject({ phase: 'processing', hidden: false });
    dismissAutoRun();
    run.progress(PROGRESS);
    expect(getAutoRunState()).toEqual({ phase: 'processing', progress: PROGRESS, hidden: true });
    run.finish();
    await done;
    expect(getAutoRunState()).toMatchObject({ phase: 'done' });
  });
});

describe('sync done', () => {
  test('listeners hear about every background sync, even a failed one', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const heard = jest.fn();
    const unsubscribe = subscribeSyncDone(heard);
    requestSync();
    jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS);
    await flush();
    expect(heard).toHaveBeenCalledTimes(1);

    mockSyncNow.mockRejectedValue(new Error('offline'));
    requestSync();
    jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS);
    await flush();
    expect(heard).toHaveBeenCalledTimes(2);

    unsubscribe();
    requestSync();
    jest.advanceTimersByTime(SYNC_AFTER_REVIEW_MS);
    await flush();
    expect(heard).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
