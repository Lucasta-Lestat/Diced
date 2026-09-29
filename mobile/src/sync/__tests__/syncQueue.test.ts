/// <reference types="jest" />
import { DEFAULT_SETTINGS, getSettings } from '../../config/settings';
import { kvGet, kvSet } from '../../db/database';
import * as library from '../../db/library';
import * as meals from '../../db/meals';
import * as weights from '../../db/weights';
import { toLocalDate } from '../../lib/dates';
import type { LibraryItem, MealEntry, WeightEntry } from '../../types';
import type { ActionName, SheetLibraryItem, SheetSummary } from '../contract';
import { getSheetInfo, getSheetsClient, refreshSheetInfo, SheetsApiError, type SheetInfo } from '../sheetsClient';
import { getCachedSummary, refreshSummary, SYNC_BATCH_SIZE, syncNow } from '../syncQueue';

jest.mock('../../config/settings', () => ({
  DEFAULT_SETTINGS: jest.requireActual('../../config/settings').DEFAULT_SETTINGS,
  getSettings: jest.fn(),
}));
jest.mock('../../db/database', () => ({ kvGet: jest.fn(), kvSet: jest.fn() }));
jest.mock('../../db/weights');
jest.mock('../../db/meals');
jest.mock('../../db/library');
jest.mock('../sheetsClient', () => ({
  SheetsApiError: jest.requireActual('../sheetsClient').SheetsApiError,
  getSheetsClient: jest.fn(),
  getSheetInfo: jest.fn(),
  refreshSheetInfo: jest.fn(),
}));

const w = jest.mocked(weights);
const m = jest.mocked(meals);
const lib = jest.mocked(library);
const mockGetSettings = jest.mocked(getSettings);
const mockGetSheetsClient = jest.mocked(getSheetsClient);
const mockGetSheetInfo = jest.mocked(getSheetInfo);
const mockRefreshSheetInfo = jest.mocked(refreshSheetInfo);
const mockKvGet = jest.mocked(kvGet);
const mockKvSet = jest.mocked(kvSet);

type Handler = (payload: any) => unknown;
let handlers: Partial<Record<ActionName, Handler>>;
let call: jest.Mock;

function weight(i: number, patch: Partial<WeightEntry> = {}): WeightEntry {
  const day = String((i % 28) + 1).padStart(2, '0');
  const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
  return {
    id: `w:Her:2027-${month}-${day}`,
    person: 'Her',
    localDate: `2027-${month}-${day}`,
    time: '07:00',
    valueLb: 180,
    chosenAssetId: null,
    source: 'photo',
    confidence: 'high',
    candidates: [],
    flags: [],
    notes: '',
    status: 'approved',
    syncError: null,
    updatedAt: 100 + i,
    ...patch,
  };
}

function meal(id: string, patch: Partial<MealEntry> = {}): MealEntry {
  return {
    id,
    person: 'Her',
    localDate: '2026-09-28',
    time: '12:00',
    slot: 'lunch',
    assetIds: [],
    estimate: null,
    final: { kcal: 500, proteinG: 30, carbsG: 50, fatG: 20 },
    title: 'Bowl',
    answers: {},
    notes: '',
    status: 'approved',
    error: null,
    updatedAt: 7,
    ...patch,
  };
}

function libItem(id: string, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    name: `Item ${id}`,
    serving: '1',
    macros: { kcal: 100, proteinG: 1, carbsG: 1, fatG: 1 },
    aliases: [],
    addedBy: 'Her',
    uses: 0,
    updatedAt: 0,
    synced: false,
    ...patch,
  };
}

function sheetLib(entryId: string, name: string): SheetLibraryItem {
  return { entryId, name, serving: '', kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, aliases: [], addedBy: 'Him', uses: 0, updatedAt: '2026-09-28T00:00:00.000Z' };
}

afterEach(() => {
  jest.restoreAllMocks();
});

const actions = () => call.mock.calls.map((c) => c[0] as ActionName);

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  handlers = {
    upsertWeights: (p) => ({ inserted: p.entries.length, updated: 0 }),
    upsertMeals: (p) => ({ inserted: p.entries.length, updated: 0 }),
    deleteEntries: (p) => ({ deleted: p.entryIds.length }),
    upsertLibrary: (p) => ({ inserted: p.items.length, updated: 0 }),
    listLibrary: () => ({ items: [] }),
  };
  call = jest.fn(async (action: ActionName, payload: unknown) => {
    const h = handlers[action];
    if (!h) throw new Error(`unexpected action ${action}`);
    return h(payload);
  });
  mockGetSheetsClient.mockResolvedValue({ call } as never);
  mockGetSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, person: 'Her', sheetWebAppUrl: 'https://x/exec' });

  w.listWeightEntries.mockResolvedValue([]);
  m.listMeals.mockResolvedValue([]);
  m.listPendingSheetDeletesWithKind.mockResolvedValue([]);
  m.getMeal.mockResolvedValue(null);
  w.getWeightEntry.mockResolvedValue(null);
  lib.listUnsyncedLibrary.mockResolvedValue([]);
});

describe('syncNow', () => {
  it('upserts approved/sync_error weights and meals in batches of ≤ 50 and marks them synced', async () => {
    const ws = Array.from({ length: 120 }, (_, i) => weight(i));
    w.listWeightEntries.mockResolvedValue(ws);
    m.listMeals.mockResolvedValue([meal('m1'), meal('m2', { status: 'sync_error', error: 'old' })]);

    const result = await syncNow();

    expect(w.listWeightEntries).toHaveBeenCalledWith({ statuses: ['approved', 'sync_error'] });
    expect(m.listMeals).toHaveBeenCalledWith({ statuses: ['approved', 'sync_error'] });
    const weightCalls = call.mock.calls.filter((c) => c[0] === 'upsertWeights');
    expect(weightCalls.map((c) => c[1].entries.length)).toEqual([50, 50, 20]);
    expect(weightCalls[0][1].entries[0]).toMatchObject({ entryId: ws[0].id, weightLb: 180, person: 'Her' });
    expect(w.markWeightsSynced).toHaveBeenCalledTimes(3);
    expect(w.markWeightsSynced.mock.calls[2][0]).toEqual(ws.slice(100).map((e) => ({ id: e.id, updatedAt: e.updatedAt })));

    const mealCall = call.mock.calls.find((c) => c[0] === 'upsertMeals')!;
    expect(mealCall[1].entries.map((r: { entryId: string }) => r.entryId)).toEqual(['m1', 'm2']);
    expect(m.markMealsSynced).toHaveBeenCalledWith([
      { id: 'm1', updatedAt: 7 },
      { id: 'm2', updatedAt: 7 },
    ]);

    expect(result).toEqual({
      weightsSynced: 120,
      mealsSynced: 2,
      deletesSynced: 0,
      libraryPushed: 0,
      libraryPulled: 0,
      errors: [],
    });
    expect(mockKvSet).toHaveBeenCalledWith('lastSync', expect.objectContaining({ weightsSynced: 120 }));
    expect(SYNC_BATCH_SIZE).toBe(50);
  });

  it('a failed batch marks only its entries sync_error and the sync continues', async () => {
    const ws = Array.from({ length: 60 }, (_, i) => weight(i));
    w.listWeightEntries.mockResolvedValue(ws);
    m.listMeals.mockResolvedValue([meal('m1')]);
    let n = 0;
    handlers.upsertWeights = (p) => {
      n += 1;
      if (n === 1) throw new SheetsApiError('Row 4: weightLb out of range', 'bad_request');
      return { inserted: p.entries.length, updated: 0 };
    };

    const result = await syncNow();

    // Guarded by updatedAt: an entry rejected or edited while the request was in flight keeps its state.
    expect(w.markWeightsSyncError).toHaveBeenCalledTimes(1);
    expect(w.markWeightsSyncError).toHaveBeenCalledWith(
      ws.slice(0, 50).map((e) => ({ id: e.id, updatedAt: e.updatedAt })),
      'Row 4: weightLb out of range',
    );
    expect(w.markWeightsSynced).toHaveBeenCalledTimes(1);
    expect(w.markWeightsSynced.mock.calls[0][0]).toHaveLength(10);
    expect(result.weightsSynced).toBe(10);
    expect(result.mealsSynced).toBe(1);
    expect(result.errors).toEqual(['Weight Log: Row 4: weightLb out of range']);
  });

  it('entries that cannot be mapped are marked sync_error and not sent', async () => {
    w.listWeightEntries.mockResolvedValue([weight(0, { valueLb: null }), weight(1)]);
    const result = await syncNow();
    expect(w.markWeightsSyncError).toHaveBeenCalledWith([{ id: weight(0).id, updatedAt: weight(0).updatedAt }], expect.stringContaining('no value'));
    const sent = call.mock.calls.find((c) => c[0] === 'upsertWeights')![1].entries;
    expect(sent.map((r: { entryId: string }) => r.entryId)).toEqual([weight(1).id]);
    expect(result.weightsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('stops making requests after a connection-level failure', async () => {
    w.listWeightEntries.mockResolvedValue(Array.from({ length: 70 }, (_, i) => weight(i)));
    m.listMeals.mockResolvedValue([meal('m1')]);
    m.listPendingSheetDeletesWithKind.mockResolvedValue([{ id: 'x', kind: 'meal' }]);
    lib.listUnsyncedLibrary.mockResolvedValue([libItem('l1')]);
    handlers.upsertWeights = () => {
      throw new SheetsApiError("Couldn't reach the sheet: offline", 'network');
    };

    const result = await syncNow();

    expect(actions()).toEqual(['upsertWeights']);
    expect(w.markWeightsSyncError.mock.calls[0][0]).toHaveLength(50);
    expect(m.markMealsSyncError).not.toHaveBeenCalled();
    expect(lib.mergeLibraryFromSheet).not.toHaveBeenCalled();
    expect(result.errors).toEqual(["Weight Log: Couldn't reach the sheet: offline"]);
  });

  it('meal batch failures mark meals sync_error', async () => {
    m.listMeals.mockResolvedValue([meal('m1')]);
    handlers.upsertMeals = () => {
      throw new SheetsApiError('Row 0: kcal out of range', 'bad_request');
    };
    const result = await syncNow();
    expect(m.markMealsSyncError).toHaveBeenCalledWith([{ id: 'm1', updatedAt: 7 }], 'Row 0: kcal out of range');
    expect(m.markMealsSynced).not.toHaveBeenCalled();
    expect(result.errors).toEqual(['Food Log: Row 0: kcal out of range']);
  });

  it('sends queued deletes per kind and drops deletes for entries that were re-approved', async () => {
    m.listPendingSheetDeletesWithKind.mockResolvedValue([
      { id: 'm-gone', kind: 'meal' },
      { id: 'm-back', kind: 'meal' },
      { id: 'w:Her:2026-09-28', kind: 'weight' },
    ]);
    m.getMeal.mockImplementation(async (id) => (id === 'm-back' ? meal('m-back', { status: 'synced' }) : null));
    w.getWeightEntry.mockResolvedValue(weight(0, { status: 'rejected' }));

    const result = await syncNow();

    expect(m.clearPendingSheetDeletes).toHaveBeenCalledWith(['m-back']);
    const deletes = call.mock.calls.filter((c) => c[0] === 'deleteEntries').map((c) => c[1]);
    expect(deletes).toEqual([
      { kind: 'meal', entryIds: ['m-gone'] },
      { kind: 'weight', entryIds: ['w:Her:2026-09-28'] },
    ]);
    expect(m.clearPendingSheetDeletes).toHaveBeenCalledWith(['m-gone']);
    expect(m.clearPendingSheetDeletes).toHaveBeenCalledWith(['w:Her:2026-09-28']);
    expect(result.deletesSynced).toBe(2);
  });

  it('a library row whose delete failed is not re-added by the pull', async () => {
    m.listPendingSheetDeletesWithKind.mockResolvedValue([{ id: 'l-del', kind: 'library' }]);
    handlers.deleteEntries = () => {
      throw new SheetsApiError('Lock timeout', 'internal');
    };
    handlers.listLibrary = () => ({ items: [sheetLib('l-del', 'Old'), sheetLib('l-keep', 'Keep')] });

    const result = await syncNow();

    expect(m.clearPendingSheetDeletes).not.toHaveBeenCalled();
    expect(lib.mergeLibraryFromSheet.mock.calls[0][0].map((i) => i.id)).toEqual(['l-keep']);
    expect(result.errors).toEqual(['Delete: Lock timeout']);
  });

  it('library deletes are sent and then no longer filtered from the pull', async () => {
    m.listPendingSheetDeletesWithKind.mockResolvedValue([{ id: 'l-del', kind: 'library' }]);
    handlers.listLibrary = () => ({ items: [sheetLib('l-del', 'Race-condition re-add')] });
    await syncNow();
    expect(call).toHaveBeenCalledWith('deleteEntries', { kind: 'library', entryIds: ['l-del'] });
    expect(m.clearPendingSheetDeletes).toHaveBeenCalledWith(['l-del']);
    expect(lib.mergeLibraryFromSheet.mock.calls[0][0].map((i) => i.id)).toEqual(['l-del']);
  });

  it('keeps a queued delete when the request fails', async () => {
    m.listPendingSheetDeletesWithKind.mockResolvedValue([{ id: 'm1', kind: 'meal' }]);
    handlers.deleteEntries = () => {
      throw new SheetsApiError('boom', 'internal');
    };
    const result = await syncNow();
    expect(m.clearPendingSheetDeletes).not.toHaveBeenCalled();
    expect(result.deletesSynced).toBe(0);
    expect(result.errors).toEqual(['Delete: boom']);
  });

  it('pulls and merges the sheet library first, then pushes unsynced items', async () => {
    const unsynced = [libItem('l1', { updatedAt: 5 })];
    lib.listUnsyncedLibrary.mockResolvedValue(unsynced);
    handlers.listLibrary = () => ({ items: [sheetLib('l1', 'Oats'), sheetLib('', ''), sheetLib('l2', 'Chili')] });

    const result = await syncNow();

    // Pulling first means a stale local copy never overwrites the other phone's newer edit.
    expect(actions()).toEqual(['listLibrary', 'upsertLibrary']);
    const merged = lib.mergeLibraryFromSheet.mock.calls[0][0];
    expect(merged.map((i) => i.id)).toEqual(['l1', 'l2']);
    expect(merged.every((i) => i.synced)).toBe(true);
    expect(lib.mergeLibraryFromSheet.mock.invocationCallOrder[0]).toBeLessThan(lib.listUnsyncedLibrary.mock.invocationCallOrder[0]);
    expect(call.mock.calls[1][1].items[0]).toMatchObject({ entryId: 'l1', name: 'Item l1' });
    expect(lib.markLibraryItemsSynced).toHaveBeenCalledWith([{ id: 'l1', updatedAt: 5, pendingUses: 0 }]);
    expect(result).toMatchObject({ libraryPushed: 1, libraryPulled: 2 });
  });

  it("adds this phone's uses to the sheet's count instead of overwriting it", async () => {
    lib.listUnsyncedLibrary.mockResolvedValue([libItem('l1', { uses: 7, pendingUses: 2, synced: true, updatedAt: 5 })]);
    await syncNow();
    expect(call.mock.calls[1][1].items[0]).toMatchObject({ entryId: 'l1', uses: 9 });
    expect(lib.markLibraryItemsSynced).toHaveBeenCalledWith([{ id: 'l1', updatedAt: 5, pendingUses: 2 }]);
  });

  it("doesn't push the library when the pull failed (it could overwrite newer rows)", async () => {
    lib.listUnsyncedLibrary.mockResolvedValue([libItem('l1')]);
    handlers.listLibrary = () => {
      throw new SheetsApiError('Food Library tab is missing', 'internal');
    };
    const result = await syncNow();
    expect(actions()).toEqual(['listLibrary']);
    expect(result.errors).toEqual(['Food Library: Food Library tab is missing']);
  });

  it('marks an entry outside the sheet bounds on its own instead of failing its batch', async () => {
    w.listWeightEntries.mockResolvedValue([weight(0, { valueLb: 18.5 }), weight(1)]);
    m.listMeals.mockResolvedValue([
      meal('typo', { final: { kcal: 12_400, proteinG: 30, carbsG: 50, fatG: 1_380 }, title: 'Stir fry' }),
      meal('ok'),
    ]);
    lib.listUnsyncedLibrary.mockResolvedValue([libItem('big', { macros: { kcal: 20_000, proteinG: 1, carbsG: 1, fatG: 1 } }), libItem('fine')]);

    const result = await syncNow();

    expect(w.markWeightsSyncError).toHaveBeenCalledWith([{ id: weight(0).id, updatedAt: weight(0).updatedAt }], expect.stringMatching(/18\.5 lb is outside 50–700 lb/));
    expect(m.markMealsSyncError).toHaveBeenCalledWith([{ id: 'typo', updatedAt: 7 }], expect.stringMatching(/Stir fry: 12,400 kcal is outside 0–10,000/));
    const sent = (action: ActionName) => call.mock.calls.find((c) => c[0] === action)![1];
    expect(sent('upsertWeights').entries.map((r: { entryId: string }) => r.entryId)).toEqual([weight(1).id]);
    expect(sent('upsertMeals').entries.map((r: { entryId: string }) => r.entryId)).toEqual(['ok']);
    expect(sent('upsertLibrary').items.map((r: { entryId: string }) => r.entryId)).toEqual(['fine']);
    expect(result).toMatchObject({ weightsSynced: 1, mealsSynced: 1, libraryPushed: 1 });
    expect(result.errors).toHaveLength(3);
  });

  it('is single-flight', async () => {
    let release!: () => void;
    w.listWeightEntries.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([]))),
    );
    const a = syncNow();
    const b = syncNow();
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(mockGetSheetsClient).toHaveBeenCalledTimes(1);

    await syncNow();
    expect(mockGetSheetsClient).toHaveBeenCalledTimes(2);
  });

  it('rejects when the sheet is not configured', async () => {
    mockGetSheetsClient.mockRejectedValueOnce(new SheetsApiError('Connect the sheet', 'not_configured'));
    await expect(syncNow()).rejects.toMatchObject({ code: 'not_configured' });
    expect(w.listWeightEntries).not.toHaveBeenCalled();
  });
});

describe('summary', () => {
  const NOW = 1_790_000_000_000; // 2026-09-21T14:13Z; expectations use toLocalDate(NOW)
  const info: SheetInfo = {
    version: '1',
    schemaVersion: 1,
    spreadsheetName: 'Plan',
    timezone: 'America/New_York',
    people: ['Her', 'Him'],
    startDate: '2026-09-14',
    eventDate: '2027-02-27',
    url: 'https://x/exec',
    fetchedAt: 1,
  };
  const summary: SheetSummary = { person: 'Her', days: [], weeks: [], currentWeek: 1 };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    handlers.getSummary = () => summary;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches startDate..today (local) for this phone’s person and caches it', async () => {
    mockGetSheetInfo.mockResolvedValue(info);
    const got = await refreshSummary();
    expect(call).toHaveBeenCalledWith('getSummary', { person: 'Her', from: '2026-09-14', to: toLocalDate(NOW) });
    expect(got).toEqual({ ...summary, fetchedAt: NOW, url: 'https://x/exec' });
    expect(mockKvSet).toHaveBeenCalledWith('summary', { ...summary, fetchedAt: NOW, url: 'https://x/exec' });
    expect(mockRefreshSheetInfo).not.toHaveBeenCalled();
  });

  it('pings for sheet info when none is cached; clamps `to` before the plan starts', async () => {
    mockGetSheetInfo.mockResolvedValue(null);
    mockRefreshSheetInfo.mockResolvedValue({ ...info, startDate: '2026-12-28' });
    await refreshSummary();
    expect(mockRefreshSheetInfo).toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('getSummary', { person: 'Her', from: '2026-12-28', to: '2026-12-28' });
  });

  it('returns null without a person or sheet connection', async () => {
    mockGetSettings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, person: null });
    expect(await refreshSummary()).toBeNull();
    mockGetSheetsClient.mockRejectedValueOnce(new SheetsApiError('x', 'not_configured'));
    expect(await refreshSummary()).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates sheet errors', async () => {
    mockGetSheetInfo.mockResolvedValue(info);
    handlers.getSummary = () => {
      throw new SheetsApiError('offline', 'network');
    };
    await expect(refreshSummary()).rejects.toMatchObject({ code: 'network' });
  });

  it('getCachedSummary returns the cache only for the current person', async () => {
    mockKvGet.mockResolvedValue({ ...summary, fetchedAt: 5, url: 'https://x/exec' } as never);
    expect(await getCachedSummary()).toEqual({ ...summary, fetchedAt: 5, url: 'https://x/exec' });
    expect(mockKvGet).toHaveBeenCalledWith('summary');
    mockGetSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, person: 'Him', sheetWebAppUrl: 'https://x/exec' });
    expect(await getCachedSummary()).toBeNull();
    mockKvGet.mockResolvedValue(null as never);
    expect(await getCachedSummary()).toBeNull();
  });

  it('getCachedSummary ignores a cache fetched from another sheet URL (or saved before URLs were kept)', async () => {
    mockKvGet.mockResolvedValue({ ...summary, fetchedAt: 5, url: 'https://old/exec' } as never);
    expect(await getCachedSummary()).toBeNull();
    mockKvGet.mockResolvedValue({ ...summary, fetchedAt: 5 } as never);
    expect(await getCachedSummary()).toBeNull();
    mockKvGet.mockResolvedValue({ ...summary, fetchedAt: 5, url: 'https://x/exec' } as never);
    mockGetSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, person: 'Her', sheetWebAppUrl: ' https://x/exec ' });
    expect(await getCachedSummary()).toEqual({ ...summary, fetchedAt: 5, url: 'https://x/exec' });
    mockGetSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, person: 'Her', sheetWebAppUrl: null });
    expect(await getCachedSummary()).toBeNull();
  });
});
