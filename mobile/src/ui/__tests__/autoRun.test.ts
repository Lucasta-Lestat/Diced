/// <reference types="jest" />
import { getSettings } from '../../config/settings';
import { isSyncing, syncNow } from '../../sync/syncQueue';
import { requestSync, SYNC_AFTER_REVIEW_MS } from '../autoRun';

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
