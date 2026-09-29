/// <reference types="jest" />
import * as SQLite from 'expo-sqlite';
import type { LibraryItem, MealEntry, PhotoRecord, ProcessResult, WeightEntry } from '../../types';
import { __resetDbForTests, getDb, kvGet, kvSet, MIGRATIONS } from '../database';
import {
  getLibraryItem,
  incrementLibraryUse,
  listLibrary,
  listUnsyncedLibrary,
  markLibraryItemsSynced,
  markLibrarySynced,
  mergeLibraryFromSheet,
  planLibraryMerge,
  upsertLibraryItem,
} from '../library';
import {
  addPendingSheetDelete,
  clearPendingSheetDeletes,
  deleteMeal,
  getMeal,
  listMeals,
  listPendingSheetDeletes,
  listPendingSheetDeletesWithKind,
  markMealsSynced,
  markMealsSyncError,
  setMealStatus,
  upsertMeal,
} from '../meals';
import {
  countByCategory,
  getPhoto,
  getPhotos,
  insertNewPhotos,
  listPickedPhotos,
  listUnclassified,
  listUnprocessed,
  markProcessed,
  setClassification,
  setPhotoError,
} from '../photos';
import { lastRuns, recordRun } from '../runs';
import {
  deleteWeightEntry,
  getWeightEntry,
  listWeightEntries,
  markWeightsSynced,
  markWeightsSyncError,
  recentAcceptedWeights,
  setWeightStatus,
  upsertWeightEntry,
} from '../weights';

// jest.mock factories are hoisted above imports, so the adapter has to be required inside.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('expo-sqlite', () => require('../testing/nodeSqlite').expoSqliteMock());

const NOW = 1_800_000_000_000;

beforeEach(() => {
  __resetDbForTests();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function photo(assetId: string, creationTime: number, patch: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    assetId,
    uri: `file:///${assetId}.jpg`,
    creationTime,
    localDate: '2026-09-28',
    origin: 'library',
    excludedReason: null,
    category: null,
    categoryConfidence: null,
    classifiedAt: null,
    processedAt: null,
    error: null,
    ...patch,
  };
}

function weight(person: string, localDate: string, patch: Partial<WeightEntry> = {}): WeightEntry {
  return {
    id: `w:${person}:${localDate}`,
    person,
    localDate,
    time: '07:10',
    valueLb: 180.2,
    chosenAssetId: 'a1',
    source: 'photo',
    confidence: 'high',
    candidates: [],
    flags: [],
    notes: '',
    status: 'needs_review',
    syncError: null,
    updatedAt: 1000,
    ...patch,
  };
}

function meal(id: string, localDate: string, time: string, patch: Partial<MealEntry> = {}): MealEntry {
  return {
    id,
    person: 'Her',
    localDate,
    time,
    slot: 'lunch',
    assetIds: [],
    estimate: null,
    final: { kcal: 500, proteinG: 30, carbsG: 50, fatG: 20 },
    title: 'Bowl',
    answers: {},
    notes: '',
    status: 'needs_review',
    error: null,
    updatedAt: 1000,
    ...patch,
  };
}

function libItem(id: string, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    name: `Item ${id}`,
    serving: '1 bowl',
    macros: { kcal: 400, proteinG: 20, carbsG: 40, fatG: 10 },
    aliases: [],
    addedBy: 'Her',
    uses: 1,
    updatedAt: 1000,
    synced: true,
    ...patch,
  };
}

describe('database', () => {
  it('opens once, migrates to the latest user_version and round-trips kv values', async () => {
    const [a, b] = await Promise.all([getDb(), getDb()]);
    expect(a).toBe(b);
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
    const row = await a.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(MIGRATIONS.length);

    expect(await kvGet('missing')).toBeNull();
    await kvSet('k', { a: 1, list: ['x'] });
    await kvSet('k', { a: 2, list: [] });
    expect(await kvGet('k')).toEqual({ a: 2, list: [] });
  });
});

describe('photos', () => {
  it('inserts only unknown photos and returns the inserted count', async () => {
    expect(await insertNewPhotos([photo('a', 1), photo('b', 2)])).toBe(2);
    expect(await insertNewPhotos([photo('a', 1, { uri: 'changed' }), photo('c', 3)])).toBe(1);
    expect((await getPhoto('a'))?.uri).toBe('file:///a.jpg');
    expect(await getPhoto('zzz')).toBeNull();
  });

  it('handles more rows than one INSERT statement', async () => {
    const many = Array.from({ length: 130 }, (_, i) => photo(`p${i}`, i));
    expect(await insertNewPhotos(many)).toBe(130);
    expect(await listUnclassified(0, 1000)).toHaveLength(130);
  });

  it('listPickedPhotos: only picked:<name> ids, capture time within [start, end]', async () => {
    await insertNewPhotos([
      photo('picked:IMG_1.jpg', 10),
      photo('picked:IMG_2.jpg', 20),
      photo('picked:late.jpg', 31),
      photo('content://media/1', 15),
      photo('capture:abc', 16),
      photo('xpicked:odd', 17),
    ]);
    expect((await listPickedPhotos(10, 30)).map((p) => p.assetId)).toEqual(['picked:IMG_1.jpg', 'picked:IMG_2.jpg']);
  });

  it('getPhotos keeps the requested order and skips unknown ids', async () => {
    await insertNewPhotos([photo('a', 1), photo('b', 2), photo('c', 3)]);
    const got = await getPhotos(['c', 'nope', 'a']);
    expect(got.map((p) => p.assetId)).toEqual(['c', 'a']);
  });

  it('listUnclassified: window [start, end), not excluded, not classified, oldest first', async () => {
    await insertNewPhotos([
      photo('late', 30),
      photo('early', 10),
      photo('excluded', 15, { excludedReason: 'screenshot' }),
      photo('classified', 16, { category: 'food', classifiedAt: 1 }),
      photo('atEnd', 40),
      photo('before', 5),
    ]);
    const got = await listUnclassified(10, 40);
    expect(got.map((p) => p.assetId)).toEqual(['early', 'late']);
  });

  it('listUnprocessed returns classified photos of the categories until processed', async () => {
    await insertNewPhotos([photo('s', 1), photo('f', 2), photo('o', 3), photo('x', 4, { excludedReason: 'screenshot' })]);
    await setClassification('s', 'scale', 0.9);
    await setClassification('f', 'food', 0.8);
    await setClassification('o', 'other', 0.99);

    expect((await getPhoto('s'))).toMatchObject({ category: 'scale', categoryConfidence: 0.9, classifiedAt: NOW });
    expect((await listUnprocessed(0, 10, ['scale'])).map((p) => p.assetId)).toEqual(['s']);
    expect((await listUnprocessed(0, 10, ['food', 'nutrition_label'])).map((p) => p.assetId)).toEqual(['f']);
    expect(await listUnprocessed(0, 10, [])).toEqual([]);

    await setPhotoError('s', 'boom');
    expect((await getPhoto('s'))?.error).toBe('boom');
    await markProcessed(['s']);
    expect(await getPhoto('s')).toMatchObject({ processedAt: NOW, error: null });
    expect(await listUnprocessed(0, 10, ['scale'])).toEqual([]);
  });

  it('countByCategory buckets excluded / unclassified / categories', async () => {
    await insertNewPhotos([
      photo('a', 1),
      photo('b', 2, { excludedReason: 'screenshot' }),
      photo('c', 3, { category: 'food' }),
      photo('d', 4, { category: 'food' }),
      photo('e', 5, { category: 'scale' }),
      photo('out', 50, { category: 'scale' }),
    ]);
    expect(await countByCategory(0, 10)).toEqual({
      scale: 1,
      food: 2,
      nutrition_label: 0,
      other: 0,
      unclassified: 1,
      excluded: 1,
    });
  });
});

describe('weights', () => {
  it('upserts, reads back and lists newest date first with filters', async () => {
    await upsertWeightEntry(weight('Her', '2026-09-28'));
    await upsertWeightEntry(weight('Her', '2026-09-30', { status: 'approved' }));
    await upsertWeightEntry(weight('Him', '2026-09-29', { status: 'approved' }));
    await upsertWeightEntry(weight('Her', '2026-09-28', { valueLb: 179.8 }));

    expect((await getWeightEntry('w:Her:2026-09-28'))?.valueLb).toBe(179.8);
    expect((await listWeightEntries()).map((e) => e.id)).toEqual([
      'w:Her:2026-09-30',
      'w:Him:2026-09-29',
      'w:Her:2026-09-28',
    ]);
    expect((await listWeightEntries({ person: 'Her', statuses: ['approved'] })).map((e) => e.id)).toEqual([
      'w:Her:2026-09-30',
    ]);
    expect((await listWeightEntries({ from: '2026-09-29', to: '2026-09-29' })).map((e) => e.id)).toEqual([
      'w:Him:2026-09-29',
    ]);
    expect(await listWeightEntries({ statuses: [] })).toEqual([]);

    await deleteWeightEntry('w:Him:2026-09-29');
    expect(await getWeightEntry('w:Him:2026-09-29')).toBeNull();
  });

  it('recentAcceptedWeights: accepted, same person, [before - days, before), newest first', async () => {
    await upsertWeightEntry(weight('Her', '2026-09-20', { status: 'approved' })); // too old
    await upsertWeightEntry(weight('Her', '2026-09-21', { status: 'synced' }));
    await upsertWeightEntry(weight('Her', '2026-09-25', { status: 'approved' }));
    await upsertWeightEntry(weight('Her', '2026-09-26', { status: 'needs_review' }));
    await upsertWeightEntry(weight('Her', '2026-09-28', { status: 'approved' })); // not before
    await upsertWeightEntry(weight('Him', '2026-09-27', { status: 'approved' }));
    const got = await recentAcceptedWeights('Her', '2026-09-28', 7);
    expect(got.map((e) => e.localDate)).toEqual(['2026-09-25', '2026-09-21']);
  });

  it('setWeightStatus updates column + JSON; sync_error keeps the old message when none given', async () => {
    await upsertWeightEntry(weight('Her', '2026-09-28', { status: 'approved' }));
    await setWeightStatus('w:Her:2026-09-28', 'sync_error', 'offline');
    expect(await getWeightEntry('w:Her:2026-09-28')).toMatchObject({
      status: 'sync_error',
      syncError: 'offline',
      updatedAt: NOW,
    });
    await setWeightStatus('w:Her:2026-09-28', 'sync_error');
    expect((await getWeightEntry('w:Her:2026-09-28'))?.syncError).toBe('offline');
    await setWeightStatus('w:Her:2026-09-28', 'approved');
    expect(await getWeightEntry('w:Her:2026-09-28')).toMatchObject({ status: 'approved', syncError: null });
    expect(await listWeightEntries({ statuses: ['approved'] })).toHaveLength(1);
  });

  it('markWeightsSyncError leaves entries changed since they were read (e.g. rejected mid-sync)', async () => {
    await upsertWeightEntry(weight('Her', '2026-09-28', { status: 'approved', updatedAt: 5 }));
    await upsertWeightEntry(weight('Her', '2026-09-29', { status: 'rejected', updatedAt: 9 }));
    const marked = await markWeightsSyncError(
      [
        { id: 'w:Her:2026-09-28', updatedAt: 5 },
        { id: 'w:Her:2026-09-29', updatedAt: 8 },
      ],
      'The sheet is busy',
    );
    expect(marked).toBe(1);
    expect(await getWeightEntry('w:Her:2026-09-28')).toMatchObject({ status: 'sync_error', syncError: 'The sheet is busy', updatedAt: NOW });
    expect(await getWeightEntry('w:Her:2026-09-29')).toMatchObject({ status: 'rejected', updatedAt: 9 });
  });

  it('markWeightsSynced skips entries edited since they were read', async () => {
    await upsertWeightEntry(weight('Her', '2026-09-28', { status: 'sync_error', syncError: 'x', updatedAt: 5 }));
    await upsertWeightEntry(weight('Her', '2026-09-29', { status: 'approved', updatedAt: 9 }));
    const marked = await markWeightsSynced([
      { id: 'w:Her:2026-09-28', updatedAt: 5 },
      { id: 'w:Her:2026-09-29', updatedAt: 8 },
    ]);
    expect(marked).toBe(1);
    expect(await getWeightEntry('w:Her:2026-09-28')).toMatchObject({ status: 'synced', syncError: null, updatedAt: 5 });
    expect((await getWeightEntry('w:Her:2026-09-29'))?.status).toBe('approved');
    expect(await listWeightEntries({ statuses: ['synced'] })).toHaveLength(1);
  });
});

describe('meals', () => {
  it('orders by date desc, time asc and filters by status', async () => {
    await upsertMeal(meal('m1', '2026-09-28', '19:00'));
    await upsertMeal(meal('m2', '2026-09-29', '12:30', { status: 'approved' }));
    await upsertMeal(meal('m3', '2026-09-28', '08:05', { status: 'approved' }));
    expect((await listMeals()).map((m) => m.id)).toEqual(['m2', 'm3', 'm1']);
    expect((await listMeals({ statuses: ['approved'], to: '2026-09-28' })).map((m) => m.id)).toEqual(['m3']);
    expect((await listMeals({ person: 'Him' }))).toEqual([]);
  });

  it('setMealStatus / markMealsSynced / deleteMeal', async () => {
    await upsertMeal(meal('m1', '2026-09-28', '12:00', { status: 'approved', updatedAt: 7 }));
    expect(await markMealsSynced([{ id: 'm1', updatedAt: 7 }])).toBe(1);
    // inSheet outlives a later re-estimate, so a reject still deletes the row.
    expect(await getMeal('m1')).toMatchObject({ status: 'synced', error: null, updatedAt: 7, inSheet: true });

    await setMealStatus('m1', 'sync_error', 'bad row');
    expect(await getMeal('m1')).toMatchObject({ status: 'sync_error', error: 'bad row', updatedAt: NOW });
    expect(await markMealsSynced([{ id: 'm1', updatedAt: 7 }])).toBe(0);

    await deleteMeal('m1');
    expect(await getMeal('m1')).toBeNull();
  });

  it('markMealsSyncError leaves a meal rejected while the request was in flight', async () => {
    await upsertMeal(meal('m1', '2026-09-28', '12:00', { status: 'approved', updatedAt: 7 }));
    await upsertMeal(meal('m2', '2026-09-28', '13:00', { status: 'rejected', updatedAt: 11 }));
    expect(
      await markMealsSyncError(
        [
          { id: 'm1', updatedAt: 7 },
          { id: 'm2', updatedAt: 10 },
        ],
        'Timed out',
      ),
    ).toBe(1);
    expect(await getMeal('m1')).toMatchObject({ status: 'sync_error', error: 'Timed out', updatedAt: NOW });
    expect(await getMeal('m2')).toMatchObject({ status: 'rejected', updatedAt: 11 });
    expect((await listMeals({ statuses: ['sync_error'] })).map((m) => m.id)).toEqual(['m1']);
  });

  it('queues sheet deletes with an inferred kind', async () => {
    await addPendingSheetDelete('meal-uuid');
    await addPendingSheetDelete('w:Her:2026-09-28');
    await addPendingSheetDelete('lib-1', 'library');
    await addPendingSheetDelete('meal-uuid');
    expect(await listPendingSheetDeletesWithKind()).toEqual([
      { id: 'lib-1', kind: 'library' },
      { id: 'meal-uuid', kind: 'meal' },
      { id: 'w:Her:2026-09-28', kind: 'weight' },
    ]);
    await clearPendingSheetDeletes(['meal-uuid', 'lib-1']);
    expect(await listPendingSheetDeletes()).toEqual(['w:Her:2026-09-28']);
  });
});

describe('library', () => {
  it('planLibraryMerge: sheet wins unless local is unsynced and newer; synced orphans are removed', () => {
    const local = [
      libItem('keep-local', { synced: false, updatedAt: 50, uses: 9 }),
      libItem('sheet-newer', { synced: false, updatedAt: 10 }),
      libItem('synced', { synced: true, updatedAt: 99 }),
      libItem('orphan-synced', { synced: true }),
      libItem('orphan-unsynced', { synced: false }),
    ];
    const sheet = [
      libItem('keep-local', { updatedAt: 40 }),
      libItem('sheet-newer', { updatedAt: 20, uses: 3 }),
      libItem('synced', { updatedAt: 1, name: 'Renamed' }),
      libItem('new', { synced: false }),
    ];
    const plan = planLibraryMerge(local, sheet);
    expect(plan.upsert.map((i) => i.id)).toEqual(['keep-local', 'sheet-newer', 'synced', 'new']);
    // The newer local edit is kept, but the use count is the sheet's (both phones add to it).
    expect(plan.upsert[0]).toMatchObject({ id: 'keep-local', synced: false, updatedAt: 50, uses: 1 });
    expect(plan.upsert.slice(1).every((i) => i.synced)).toBe(true);
    expect(plan.remove).toEqual(['orphan-synced']);
  });

  it("planLibraryMerge: a stale copy with only new uses takes the sheet's content and keeps the uses pending", () => {
    // Him changed the calories; Her's phone only counted a use on its old copy.
    const local = [libItem('oats', { synced: true, updatedAt: 10, uses: 3, pendingUses: 1, macros: { kcal: 350, proteinG: 1, carbsG: 1, fatG: 1 } })];
    const sheet = [libItem('oats', { updatedAt: 20, uses: 5, macros: { kcal: 420, proteinG: 1, carbsG: 1, fatG: 1 } })];
    const [merged] = planLibraryMerge(local, sheet).upsert;
    expect(merged).toMatchObject({ synced: true, updatedAt: 20, uses: 5, pendingUses: 1, macros: { kcal: 420 } });
  });

  it('merges, tracks unsynced items and increments uses', async () => {
    await upsertLibraryItem(libItem('b', { name: 'banana bread', synced: false, updatedAt: 50 }));
    await upsertLibraryItem(libItem('a', { name: 'Apple oats', synced: true }));
    expect((await listLibrary()).map((i) => i.id)).toEqual(['a', 'b']);

    await mergeLibraryFromSheet([libItem('c', { name: 'Chili' })]);
    expect((await listLibrary()).map((i) => i.id)).toEqual(['b', 'c']);

    expect((await listUnsyncedLibrary()).map((i) => i.id)).toEqual(['b']);
    await markLibrarySynced(['b']);
    expect(await listUnsyncedLibrary()).toEqual([]);
    expect((await getLibraryItem('b'))?.synced).toBe(true);

    const before = await getLibraryItem('c');
    await incrementLibraryUse('c');
    // A use is pending on top of the sheet's count; content and updatedAt are untouched.
    expect(await getLibraryItem('c')).toMatchObject({ uses: before?.uses, pendingUses: 1, synced: true, updatedAt: before?.updatedAt });
    expect((await listUnsyncedLibrary()).map((i) => i.id)).toEqual(['c']);
    await incrementLibraryUse('c');

    // Two uses were pushed; one more is counted while the request is in flight.
    const pushed = (await getLibraryItem('c'))!;
    await incrementLibraryUse('c');
    expect(await markLibraryItemsSynced([{ id: 'c', updatedAt: pushed.updatedAt, pendingUses: 2 }])).toBe(1);
    expect(await getLibraryItem('c')).toMatchObject({ uses: (before?.uses ?? 0) + 2, pendingUses: 1, synced: true });
    expect(await markLibraryItemsSynced([{ id: 'c', updatedAt: pushed.updatedAt, pendingUses: 1 }])).toBe(1);
    expect(await getLibraryItem('c')).not.toHaveProperty('pendingUses');
    expect(await listUnsyncedLibrary()).toEqual([]);

    // Content edited since it was read: uses still fold in, but it stays unsynced.
    await upsertLibraryItem({ ...(await getLibraryItem('b'))!, synced: false, updatedAt: 70, pendingUses: 1 });
    expect(await markLibraryItemsSynced([{ id: 'b', updatedAt: 60, pendingUses: 1 }])).toBe(0);
    expect(await getLibraryItem('b')).toMatchObject({ synced: false, uses: 2 });
  });
});

describe('runs', () => {
  it('records runs and returns the most recent first', async () => {
    const result: ProcessResult = {
      reason: 'manual',
      windowStart: 0,
      windowEnd: 1,
      photosScanned: 3,
      photosExcluded: 0,
      photosClassified: 3,
      scalePhotos: 1,
      foodPhotos: 2,
      weightEntriesCreated: 1,
      mealsCreated: 1,
      errors: [],
      partial: false,
    };
    await recordRun(10, result);
    await recordRun(20, { ...result, reason: 'weekly', partial: true });
    const runs = await lastRuns(5);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ reason: 'weekly', partial: true, startedAt: 20, finishedAt: NOW });
    expect(runs[1]).toMatchObject({ reason: 'manual', startedAt: 10 });
    expect(await lastRuns(1)).toHaveLength(1);
  });
});
