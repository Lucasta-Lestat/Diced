/// <reference types="jest" />
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { getSettings, updateSettings } from '../../config/settings';
import { processPhotos } from '../../pipeline/process';
import { syncNow } from '../../sync/syncQueue';
import type { AppSettings, ProcessResult } from '../../types';
import {
  BACKGROUND_TASK,
  backgroundTaskStatus,
  defineBackgroundTask,
  dueAutoRun,
  registerBackgroundTask,
  runBackgroundTask,
  unregisterBackgroundTask,
} from '../background';
import { notifyReviewReady } from '../notifications';

jest.mock('react-native', () => {
  const rn = jest.requireActual('react-native');
  rn.Platform.OS = 'android';
  return rn;
});
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: jest.fn(),
  registerTaskAsync: jest.fn(async () => undefined),
  unregisterTaskAsync: jest.fn(async () => undefined),
  addExpirationListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskDefined: jest.fn(() => false),
  isTaskRegisteredAsync: jest.fn(async () => false),
  isAvailableAsync: jest.fn(async () => true),
}));
jest.mock('../../config/settings', () => ({ getSettings: jest.fn(), updateSettings: jest.fn(async () => ({})) }));
jest.mock('../../pipeline/process', () => ({ processPhotos: jest.fn() }));
jest.mock('../../sync/syncQueue', () => ({ syncNow: jest.fn() }));
jest.mock('../notifications', () => ({ notifyReviewReady: jest.fn(async () => undefined) }));

const BT = jest.mocked(BackgroundTask);
const TM = jest.mocked(TaskManager);
const mockGetSettings = jest.mocked(getSettings);
const mockUpdateSettings = jest.mocked(updateSettings);
const mockProcess = jest.mocked(processPhotos);
const mockSync = jest.mocked(syncNow);
const mockNotify = jest.mocked(notifyReviewReady);

const SUCCESS = BackgroundTask.BackgroundTaskResult.Success;
const FAILED = BackgroundTask.BackgroundTaskResult.Failed;

const at = (y: number, month: number, d: number, h = 0, min = 0) => new Date(y, month - 1, d, h, min).getTime();

const BASE: AppSettings = {
  person: 'Him',
  sheetWebAppUrl: 'https://script.google.com/macros/s/abc/exec',
  scheduleWeekday: 1,
  scheduleHour: 9,
  scheduleMinute: 0,
  processDaily: true,
  classificationMode: 'cloud_thumbnails',
  accuracyMode: 'standard',
  webLookupForRestaurants: true,
  plateDiameterIn: null,
  scaleUnit: 'lb',
  mealGroupingMinutes: 20,
  morningCutoffHour: 11,
  model: 'claude-opus-5-5',
  lastScanEnd: null,
  lastAutoRunAt: null,
  onboardingComplete: true,
};
const settings = (patch: Partial<AppSettings> = {}): AppSettings => ({ ...BASE, ...patch });

function result(patch: Partial<ProcessResult> = {}): ProcessResult {
  return {
    reason: 'weekly',
    windowStart: 0,
    windowEnd: 1,
    photosScanned: 10,
    photosExcluded: 1,
    photosClassified: 9,
    scalePhotos: 2,
    foodPhotos: 5,
    weightEntriesCreated: 2,
    mealsCreated: 4,
    errors: [],
    partial: false,
    ...patch,
  };
}

const syncOk = { weightsSynced: 0, mealsSynced: 0, deletesSynced: 0, libraryPushed: 0, libraryPulled: 0, errors: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mockSync.mockResolvedValue(syncOk);
  mockProcess.mockResolvedValue(result());
});

describe('dueAutoRun', () => {
  const now = at(2026, 9, 28, 10, 0); // Monday, after the 09:00 slot

  it('prefers the weekly run', () => {
    expect(dueAutoRun(settings({ lastAutoRunAt: at(2026, 9, 27, 8, 0) }), now)).toBe('weekly');
  });

  it('falls back to the daily run once 20 hours have passed', () => {
    const afterSlot = settings({ lastAutoRunAt: at(2026, 9, 28, 9, 30) });
    expect(dueAutoRun(afterSlot, at(2026, 9, 28, 20, 0))).toBeNull();
    expect(dueAutoRun(afterSlot, at(2026, 9, 29, 6, 0))).toBe('daily');
  });

  it('never runs in manual mode or without a person/sheet', () => {
    expect(dueAutoRun(settings({ classificationMode: 'manual' }), now)).toBeNull();
    expect(dueAutoRun(settings({ person: null }), now)).toBeNull();
    expect(dueAutoRun(settings({ sheetWebAppUrl: null }), now)).toBeNull();
  });
});

describe('runBackgroundTask', () => {
  it('does nothing when the sheet is not configured', async () => {
    mockGetSettings.mockResolvedValue(settings({ sheetWebAppUrl: null }));
    await expect(runBackgroundTask()).resolves.toBe(SUCCESS);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('processes a due run with the Android budget, records it, notifies and syncs', async () => {
    mockGetSettings.mockResolvedValue(settings({ lastAutoRunAt: null }));
    await expect(runBackgroundTask()).resolves.toBe(SUCCESS);
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ reason: 'weekly', timeBudgetMs: 8 * 60_000 }));
    expect(mockUpdateSettings).toHaveBeenCalledWith({ lastAutoRunAt: expect.any(Number) });
    expect(mockNotify).toHaveBeenCalledWith(2, 4);
    expect(mockSync).toHaveBeenCalled();
  });

  it('leaves a partial run due so the next wake-up resumes it', async () => {
    mockGetSettings.mockResolvedValue(settings({ lastAutoRunAt: null }));
    mockProcess.mockResolvedValue(result({ partial: true, weightEntriesCreated: 1, mealsCreated: 0 }));
    await expect(runBackgroundTask()).resolves.toBe(SUCCESS);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(1, 0);
  });

  it('does not fail a finished run because the notification could not be posted', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetSettings.mockResolvedValue(settings({ lastAutoRunAt: null }));
    mockNotify.mockRejectedValueOnce(new Error('notifications disabled'));
    await expect(runBackgroundTask()).resolves.toBe(SUCCESS);
    expect(mockUpdateSettings).toHaveBeenCalled();
  });

  it('only syncs in manual mode', async () => {
    mockGetSettings.mockResolvedValue(settings({ classificationMode: 'manual' }));
    await expect(runBackgroundTask()).resolves.toBe(SUCCESS);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockSync).toHaveBeenCalled();
  });

  it('reports failure without throwing, and still syncs', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetSettings.mockResolvedValue(settings({ lastAutoRunAt: null }));
    mockProcess.mockRejectedValue(new Error('no API key'));
    await expect(runBackgroundTask()).resolves.toBe(FAILED);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(mockSync).toHaveBeenCalled();
  });

  it('reports failure when settings cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetSettings.mockRejectedValue(new Error('db locked'));
    await expect(runBackgroundTask()).resolves.toBe(FAILED);
  });
});

describe('defineBackgroundTask', () => {
  it('defines the task once', () => {
    TM.isTaskDefined.mockReturnValueOnce(false).mockReturnValueOnce(true);
    defineBackgroundTask();
    defineBackgroundTask();
    expect(TM.defineTask).toHaveBeenCalledTimes(1);
    expect(TM.defineTask).toHaveBeenCalledWith(BACKGROUND_TASK, expect.any(Function));
  });
});

describe('registration', () => {
  it('registers with a 12 hour minimum interval (in minutes)', async () => {
    BT.getStatusAsync.mockResolvedValue(BackgroundTask.BackgroundTaskStatus.Available);
    await registerBackgroundTask();
    expect(BT.registerTaskAsync).toHaveBeenCalledWith(BACKGROUND_TASK, { minimumInterval: 720 });
  });

  it('is idempotent', async () => {
    BT.getStatusAsync.mockResolvedValue(BackgroundTask.BackgroundTaskStatus.Available);
    TM.isTaskRegisteredAsync.mockResolvedValueOnce(true);
    await registerBackgroundTask();
    expect(BT.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('is a no-op when background tasks are restricted or TaskManager is unavailable', async () => {
    BT.getStatusAsync.mockResolvedValue(BackgroundTask.BackgroundTaskStatus.Restricted);
    await registerBackgroundTask();
    TM.isAvailableAsync.mockResolvedValueOnce(false);
    BT.getStatusAsync.mockResolvedValue(BackgroundTask.BackgroundTaskStatus.Available);
    await registerBackgroundTask();
    expect(BT.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('unregisters when available', async () => {
    await unregisterBackgroundTask();
    expect(BT.unregisterTaskAsync).toHaveBeenCalledWith(BACKGROUND_TASK);
  });
});

describe('backgroundTaskStatus', () => {
  it('maps the native status', async () => {
    BT.getStatusAsync.mockResolvedValueOnce(BackgroundTask.BackgroundTaskStatus.Available);
    await expect(backgroundTaskStatus()).resolves.toBe('available');
    BT.getStatusAsync.mockResolvedValueOnce(BackgroundTask.BackgroundTaskStatus.Restricted);
    await expect(backgroundTaskStatus()).resolves.toBe('restricted');
    BT.getStatusAsync.mockRejectedValueOnce(new Error('unavailable'));
    await expect(backgroundTaskStatus()).resolves.toBe('unavailable');
    TM.isAvailableAsync.mockResolvedValueOnce(false);
    await expect(backgroundTaskStatus()).resolves.toBe('unavailable');
  });
});
