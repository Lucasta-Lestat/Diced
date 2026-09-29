/// <reference types="jest" />
import { getSettings } from '../../config/settings';
import { incrementLibraryUse, listLibrary, upsertLibraryItem } from '../../db/library';
import { addPendingSheetDelete, deleteMeal, getMeal, listMeals, upsertMeal } from '../../db/meals';
import { getPhotos } from '../../db/photos';
import { getWeightEntry, listWeightEntries, recentAcceptedWeights, upsertWeightEntry } from '../../db/weights';
import { toLocalDate } from '../../lib/dates';
import type {
  AppSettings,
  FoodItem,
  LibraryItem,
  MealEntry,
  MealEstimate,
  PhotoRecord,
  WeightCandidate,
  WeightEntry,
} from '../../types';
import { estimateAndReconcile, loadMealImages } from '../mealEstimate';
import {
  addManualMeal,
  addManualWeight,
  approveAllConfident,
  approveMeal,
  approveWeight,
  chooseWeightCandidate,
  combineMeals,
  editMeal,
  MealChangedError,
  mergeMeals,
  reestimateMeal,
  rejectMeal,
  rejectWeight,
  saveMealToLibrary,
} from '../review';

jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuid}` }));
jest.mock('../../config/settings', () => ({ getSettings: jest.fn(), getSecret: jest.fn() }));
jest.mock('../../db/database', () => ({ kvGet: jest.fn(), kvSet: jest.fn() }));
jest.mock('../../db/library', () => ({ incrementLibraryUse: jest.fn(), listLibrary: jest.fn(), upsertLibraryItem: jest.fn() }));
jest.mock('../../db/meals', () => ({
  addPendingSheetDelete: jest.fn(),
  deleteMeal: jest.fn(),
  getMeal: jest.fn(),
  listMeals: jest.fn(),
  upsertMeal: jest.fn(),
}));
jest.mock('../../db/photos', () => ({ getPhotos: jest.fn() }));
jest.mock('../../db/weights', () => ({
  getWeightEntry: jest.fn(),
  listWeightEntries: jest.fn(),
  recentAcceptedWeights: jest.fn(),
  upsertWeightEntry: jest.fn(),
}));
jest.mock('../../ai/restaurant', () => ({ lookupPublishedNutrition: jest.fn() }));
jest.mock('../mealEstimate', () => ({ estimateAndReconcile: jest.fn(), loadMealImages: jest.fn() }));

let mockUuid = 0;

// Local wall-clock times (Sep 2026), so the tests hold in any time zone.
const at = (d: number, h: number, min = 0) => new Date(2026, 8, d, h, min).getTime();
const NOW = at(30, 12);

const SETTINGS = {
  person: 'Her',
  morningCutoffHour: 11,
  scaleUnit: 'lb',
  plateDiameterIn: null,
  accuracyMode: 'standard',
  webLookupForRestaurants: true,
} as AppSettings;

let weights: Map<string, WeightEntry>;
let meals: Map<string, MealEntry>;
let libraryItems: LibraryItem[];
let photos: Map<string, PhotoRecord>;

const cand = (assetId: string, takenAt: number, valueLb: number): WeightCandidate => ({
  assetId,
  takenAt,
  valueLb,
  rawValue: valueLb,
  rawUnit: 'lb',
  readConfidence: 'high',
});

function weight(patch: Partial<WeightEntry> = {}): WeightEntry {
  return {
    id: 'w:Her:2026-09-28',
    person: 'Her',
    localDate: '2026-09-28',
    time: '07:00',
    valueLb: 185,
    chosenAssetId: 'a',
    source: 'photo',
    confidence: 'high',
    candidates: [cand('a', at(28, 7), 185), cand('b', at(28, 19), 187.2)],
    flags: [],
    notes: '',
    status: 'needs_review',
    syncError: null,
    updatedAt: 1,
    ...patch,
  };
}

function foodItem(name: string, grams: number | null, kcal: number): FoodItem {
  return {
    name,
    portion: `${grams ?? 1} g`,
    grams,
    macros: { kcal, proteinG: 20, carbsG: 30, fatG: 10 },
    source: 'usda',
    confidence: 'high',
    usdaQuery: name,
    fdcId: 1,
    modelMacros: null,
  };
}

function estimate(patch: Partial<MealEstimate> = {}): MealEstimate {
  return {
    title: 'Chicken and rice',
    items: [foodItem('chicken', 150, 250), foodItem('rice', 200, 260)],
    totals: { kcal: 510, proteinG: 40, carbsG: 60, fatG: 20 },
    kcalLow: 408,
    kcalHigh: 663,
    confidence: 'high',
    method: 'photo',
    questions: [],
    assumptions: [],
    libraryItemId: null,
    brand: null,
    barcode: null,
    model: 'claude-opus-5-5',
    samples: 1,
    createdAt: 1,
    ...patch,
  };
}

function meal(patch: Partial<MealEntry> = {}): MealEntry {
  const est = patch.estimate === undefined ? estimate() : patch.estimate;
  return {
    id: 'm1',
    person: 'Her',
    localDate: '2026-09-28',
    time: '12:30',
    slot: 'lunch',
    assetIds: ['p1'],
    estimate: est,
    final: est ? { ...est.totals } : { kcal: 500, proteinG: 20, carbsG: 50, fatG: 20 },
    title: est?.title ?? 'Leftovers',
    answers: {},
    notes: '',
    status: 'needs_review',
    error: null,
    updatedAt: 1,
    ...patch,
  };
}

function photo(id: string, time: number): PhotoRecord {
  return {
    assetId: id,
    uri: `ph://${id}`,
    creationTime: time,
    localDate: toLocalDate(time),
    origin: 'library',
    excludedReason: null,
    category: 'food',
    categoryConfidence: 0.9,
    classifiedAt: 1,
    processedAt: 1,
    error: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUuid = 0;
  weights = new Map();
  meals = new Map();
  libraryItems = [];
  photos = new Map();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  jest.mocked(getSettings).mockResolvedValue({ ...SETTINGS });
  jest.mocked(getWeightEntry).mockImplementation(async (id) => weights.get(id) ?? null);
  jest.mocked(upsertWeightEntry).mockImplementation(async (e) => void weights.set(e.id, e));
  jest.mocked(listWeightEntries).mockImplementation(async (f) =>
    [...weights.values()].filter((e) => !f?.statuses || f.statuses.includes(e.status)),
  );
  jest.mocked(recentAcceptedWeights).mockResolvedValue([]);
  jest.mocked(getMeal).mockImplementation(async (id) => meals.get(id) ?? null);
  jest.mocked(upsertMeal).mockImplementation(async (m) => void meals.set(m.id, m));
  jest.mocked(deleteMeal).mockImplementation(async (id) => void meals.delete(id));
  jest.mocked(listMeals).mockImplementation(async (f) => [...meals.values()].filter((m) => !f?.statuses || f.statuses.includes(m.status)));
  jest.mocked(addPendingSheetDelete).mockResolvedValue(undefined);
  jest.mocked(listLibrary).mockImplementation(async () => libraryItems);
  jest.mocked(upsertLibraryItem).mockImplementation(async (item) => {
    libraryItems = [...libraryItems.filter((i) => i.id !== item.id), item];
  });
  jest.mocked(incrementLibraryUse).mockResolvedValue(undefined);
  jest.mocked(getPhotos).mockImplementation(async (ids) => ids.flatMap((id) => (photos.has(id) ? [photos.get(id)!] : [])));
  jest.mocked(loadMealImages).mockImplementation(async (records) => ({
    images: records.map((r) => ({ image: { base64: r.assetId, mediaType: 'image/jpeg' as const, width: 1, height: 1 }, takenAt: r.creationTime })),
    missing: [],
  }));
  jest.mocked(estimateAndReconcile).mockResolvedValue(
    estimate({ title: 'Grilled chicken with rice', totals: { kcal: 620, proteinG: 45, carbsG: 70, fatG: 18 } }),
  );
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('weigh-in review', () => {
  it('approves with the chosen value, or a corrected one with notes', async () => {
    weights.set('w:Her:2026-09-28', weight());
    expect(await approveWeight('w:Her:2026-09-28')).toMatchObject({ status: 'approved', valueLb: 185, updatedAt: NOW });

    weights.set('w:Her:2026-09-28', weight({ status: 'sync_error', syncError: 'offline' }));
    const edited = await approveWeight('w:Her:2026-09-28', 184.64, 'scale was on carpet');
    expect(edited).toMatchObject({ status: 'approved', valueLb: 184.6, notes: 'scale was on carpet', syncError: null });
  });

  it('refuses implausible or missing values and unknown entries', async () => {
    weights.set('w:Her:2026-09-28', weight({ valueLb: null }));
    await expect(approveWeight('w:Her:2026-09-28')).rejects.toThrow(/Enter a weight/);
    await expect(approveWeight('w:Her:2026-09-28', 18.5)).rejects.toThrow(/between 50 and 700/);
    await expect(approveWeight('w:Her:2026-09-01')).rejects.toThrow(/no longer exists/);
  });

  it('switches to another candidate and recomputes flags', async () => {
    weights.set('w:Her:2026-09-28', weight({ status: 'synced' }));
    const e = await chooseWeightCandidate('w:Her:2026-09-28', 'b');
    expect(e).toMatchObject({
      chosenAssetId: 'b',
      valueLb: 187.2,
      time: '19:00',
      flags: ['not_morning'],
      status: 'approved',
      updatedAt: NOW,
    });
    await expect(chooseWeightCandidate('w:Her:2026-09-28', 'zzz')).rejects.toThrow(/readings/);
  });

  it('remembers a hand-picked reading', async () => {
    weights.set('w:Her:2026-09-28', weight());
    expect(await chooseWeightCandidate('w:Her:2026-09-28', 'b')).toMatchObject({ chosenAssetId: 'b', chosenByUser: true, status: 'needs_review' });
  });

  it("won't put an implausible reading on an accepted day (the sheet would reject its whole batch)", async () => {
    const misread = cand('c', at(28, 7, 5), 18.5);
    weights.set('w:Her:2026-09-28', weight({ status: 'synced', candidates: [...weight().candidates, misread] }));
    await expect(chooseWeightCandidate('w:Her:2026-09-28', 'c')).rejects.toThrow(/18\.5 lb\) is outside 50–700 lb/);
    expect(weights.get('w:Her:2026-09-28')).toMatchObject({ status: 'synced', valueLb: 185 });
    // Still in review: allowed, and approving it is refused later.
    weights.set('w:Her:2026-09-28', weight({ candidates: [...weight().candidates, misread] }));
    expect(await chooseWeightCandidate('w:Her:2026-09-28', 'c')).toMatchObject({ valueLb: 18.5, flags: expect.arrayContaining(['implausible_value']) });
    await expect(approveWeight('w:Her:2026-09-28')).rejects.toThrow(/between 50 and 700/);
  });

  it('queues a sheet delete only for a rejected entry that reached the sheet', async () => {
    weights.set('w:Her:2026-09-28', weight({ status: 'synced' }));
    await rejectWeight('w:Her:2026-09-28');
    expect(addPendingSheetDelete).toHaveBeenCalledWith('w:Her:2026-09-28', 'weight');
    expect(weights.get('w:Her:2026-09-28')).toMatchObject({ status: 'rejected', updatedAt: NOW });

    jest.mocked(addPendingSheetDelete).mockClear();
    weights.set('w:Her:2026-09-28', weight());
    await rejectWeight('w:Her:2026-09-28');
    expect(addPendingSheetDelete).not.toHaveBeenCalled();
  });

  it('adds a manual weigh-in as the approved entry of the day', async () => {
    weights.set('w:Her:2026-09-28', weight());
    const e = await addManualWeight('2026-09-28', 184.36, ' before breakfast ');
    expect(e).toEqual({
      id: 'w:Her:2026-09-28',
      person: 'Her',
      localDate: '2026-09-28',
      time: null,
      valueLb: 184.4,
      chosenAssetId: null,
      source: 'manual',
      confidence: 'high',
      candidates: weight().candidates,
      flags: [],
      notes: 'before breakfast',
      status: 'approved',
      syncError: null,
      updatedAt: NOW,
    });
    await expect(addManualWeight('2026-02-30', 180, '')).rejects.toThrow(/valid date/);
    await expect(addManualWeight('2026-09-29', 1800, '')).rejects.toThrow(/between/);
  });

  it('needs a person for manual entries', async () => {
    jest.mocked(getSettings).mockResolvedValue({ ...SETTINGS, person: null });
    await expect(addManualWeight('2026-09-28', 180, '')).rejects.toThrow(/Her or Him/);
  });
});

describe('meal review', () => {
  it('rescales an item from new grams and recomputes totals and final', async () => {
    meals.set('m1', meal());
    const m = await editMeal('m1', { itemGrams: { 1: 100 } });
    expect(m.estimate?.items[1]).toMatchObject({ grams: 100, macros: { kcal: 130, proteinG: 10, carbsG: 15, fatG: 5 } });
    expect(m.estimate?.items[0].macros.kcal).toBe(250);
    expect(m.estimate?.totals).toEqual({ kcal: 380, proteinG: 30, carbsG: 45, fatG: 15 });
    expect(m.final).toEqual({ kcal: 380, proteinG: 30, carbsG: 45, fatG: 15 });
    expect(m.estimate?.kcalLow).toBe(Math.round(380 * (408 / 510)));
    expect(m.updatedAt).toBe(NOW);
  });

  it('uses an explicit final over the item totals and edits the other fields', async () => {
    meals.set('m1', meal({ status: 'synced', answers: { q1: 'none' } }));
    const m = await editMeal('m1', {
      itemGrams: { 0: 300 },
      final: { kcal: 700.4, proteinG: 50, carbsG: 60, fatG: 25 },
      title: ' Chicken rice bowl ',
      slot: 'dinner',
      time: '18:45',
      notes: 'half the rice',
      answers: { q1: '', q2: '1 tbsp' },
    });
    expect(m).toMatchObject({
      final: { kcal: 700, proteinG: 50, carbsG: 60, fatG: 25 },
      title: 'Chicken rice bowl',
      slot: 'dinner',
      time: '18:45',
      notes: 'half the rice',
      answers: { q2: '1 tbsp' },
      status: 'approved',
    });
    expect(m.estimate?.items[0].macros.kcal).toBe(500);
    await expect(editMeal('m1', { time: '25:00' })).rejects.toThrow(/13:45/);
  });

  it('refuses grams that would push a synced meal past the sheet limits', async () => {
    meals.set('m1', meal({ status: 'synced' }));
    // rice: 200 g = 260 kcal; a typo of 20000 g → 26,000 kcal.
    await expect(editMeal('m1', { itemGrams: { 1: 20_000 } })).rejects.toThrow(/10,000 kcal/);
    expect(meals.get('m1')).toMatchObject({ status: 'synced', final: { kcal: 510 } });
  });

  it('records grams for items without known grams without inventing macros', async () => {
    meals.set('m1', meal({ estimate: estimate({ items: [foodItem('sauce', null, 90)] }) }));
    const m = await editMeal('m1', { itemGrams: { 0: 40 } });
    expect(m.estimate?.items[0]).toMatchObject({ grams: 40, macros: { kcal: 90 } });
  });

  it('re-estimates with notes, answered questions and keeps a title the user typed', async () => {
    const q = { id: 'q1', question: 'Was it cooked in oil?', options: ['No', '1 tsp', '1 tbsp'], affects: ['chicken'] };
    const open = { id: 'q2', question: 'Any sauce?', options: ['No', 'Yes'], affects: [] };
    photos.set('p1', photo('p1', at(28, 12, 30)));
    meals.set('m1', meal({ estimate: estimate({ questions: [q, open] }), answers: { q1: '1 tbsp' }, notes: 'large plate', title: 'My lunch', status: 'synced' }));

    const m = await reestimateMeal('m1');

    expect(estimateAndReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'lunch',
        notes: 'large plate',
        answers: [{ question: 'Was it cooked in oil?', answer: '1 tbsp' }],
        hint: 'My lunch large plate',
      }),
    );
    expect(m).toMatchObject({ title: 'My lunch', final: { kcal: 620 }, status: 'needs_review', error: null, updatedAt: NOW });
    expect(m.estimate?.questions.map((x) => x.id)).toEqual(['q1']);
  });

  it("keeps a new question the model numbers like an answered one (every estimate starts at q1)", async () => {
    const oil = { id: 'q1', question: 'How much oil was the chicken cooked in?', options: ['None', '1 tbsp'], affects: ['chicken'] };
    const dressing = { id: 'q2', question: 'Regular or light dressing?', options: ['Regular', 'Light'], affects: [] };
    photos.set('p1', photo('p1', at(28, 12, 30)));
    meals.set('m1', meal({ estimate: estimate({ questions: [oil, dressing] }), answers: { q1: '1 tbsp', q7: 'stale answer' } }));
    // The model doesn't repeat the answered question; its open one comes back as q1.
    jest.mocked(estimateAndReconcile).mockResolvedValue(
      estimate({ questions: [{ ...dressing, id: 'q1' }, { ...oil, id: 'q2', question: 'how much oil was the chicken cooked in' }] }),
    );

    const m = await reestimateMeal('m1');

    expect(m.estimate?.questions.map((q) => [q.id, q.question])).toEqual([
      ['q1', 'How much oil was the chicken cooked in?'],
      ['q2', 'Regular or light dressing?'],
    ]);
    // The dressing question is open, and answers of questions no longer listed are dropped.
    expect(m.answers).toEqual({ q1: '1 tbsp' });
  });

  it('puts a synced meal back in review after a re-estimate, and rejecting it still deletes its row', async () => {
    photos.set('p1', photo('p1', at(28, 12, 30)));
    meals.set('m1', meal({ status: 'synced' }));
    const m = await reestimateMeal('m1');
    expect(m).toMatchObject({ status: 'needs_review', inSheet: true });

    await rejectMeal('m1');
    expect(addPendingSheetDelete).toHaveBeenCalledWith('m1', 'meal');
    expect(meals.get('m1')?.status).toBe('rejected');
  });

  it("doesn't overwrite a meal approved while it was being re-estimated", async () => {
    photos.set('p1', photo('p1', at(28, 12, 30)));
    meals.set('m1', meal());
    jest.mocked(estimateAndReconcile).mockImplementation(async () => {
      // Approved from the list card while Claude was working.
      meals.set('m1', { ...meals.get('m1')!, status: 'approved', updatedAt: 99 });
      return estimate({ totals: { kcal: 900, proteinG: 1, carbsG: 1, fatG: 1 } });
    });
    const err = await reestimateMeal('m1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MealChangedError); // the screen reloads the meal on this error
    expect((err as Error).message).toMatch(/changed while it was being re-estimated/);
    expect(meals.get('m1')).toMatchObject({ status: 'approved', final: { kcal: 510 } });
  });

  it("takes the model's new title when the user didn't change it", async () => {
    photos.set('p1', photo('p1', at(28, 12, 30)));
    meals.set('m1', meal());
    expect((await reestimateMeal('m1')).title).toBe('Grilled chicken with rice');
  });

  it('refuses to re-estimate a meal without photos', async () => {
    meals.set('m1', meal({ assetIds: [] }));
    await expect(reestimateMeal('m1')).rejects.toThrow(/no photos/);
  });

  it('approves, counting a matched usual meal once', async () => {
    meals.set('m1', meal({ estimate: estimate({ libraryItemId: 'lib-1' }) }));
    expect(await approveMeal('m1')).toMatchObject({ status: 'approved', updatedAt: NOW });
    expect(incrementLibraryUse).toHaveBeenCalledWith('lib-1');
    await approveMeal('m1');
    expect(incrementLibraryUse).toHaveBeenCalledTimes(1);
  });

  it('queues a sheet delete when rejecting a synced meal', async () => {
    meals.set('m1', meal({ status: 'synced' }));
    await rejectMeal('m1');
    expect(addPendingSheetDelete).toHaveBeenCalledWith('m1', 'meal');
    expect(meals.get('m1')).toMatchObject({ status: 'rejected', updatedAt: NOW });

    jest.mocked(addPendingSheetDelete).mockClear();
    meals.set('m2', meal({ id: 'm2' }));
    await rejectMeal('m2');
    expect(addPendingSheetDelete).not.toHaveBeenCalled();
  });

  it('merges two meals, re-estimates and removes the second one (also from the sheet)', async () => {
    photos.set('p1', photo('p1', at(28, 12, 30)));
    photos.set('p2', photo('p2', at(28, 12, 5)));
    meals.set('m1', meal({ notes: 'main' }));
    meals.set('m2', meal({ id: 'm2', assetIds: ['p2'], time: '12:05', notes: 'drink', status: 'synced' }));

    const m = await mergeMeals('m1', 'm2');

    expect(m).toMatchObject({ id: 'm1', assetIds: ['p2', 'p1'], time: '12:05', notes: 'main\ndrink', status: 'needs_review', final: { kcal: 620 } });
    expect(meals.has('m2')).toBe(false);
    expect(addPendingSheetDelete).toHaveBeenCalledWith('m2', 'meal');
  });

  it("doesn't pair one meal's answer with the other meal's question when merging", async () => {
    const oil = { id: 'q1', question: 'How much oil?', options: ['None', '1 tbsp'], affects: [] };
    const soda = { id: 'q1', question: 'Regular or diet soda?', options: ['Regular', 'Diet'], affects: [] };
    const size = { id: 'q2', question: 'Drink size?', options: ['Small', 'Large'], affects: [] };
    photos.set('p1', photo('p1', at(28, 12, 30)));
    photos.set('p2', photo('p2', at(28, 12, 55)));
    meals.set('m1', meal({ estimate: estimate({ questions: [oil] }), answers: { q1: '1 tbsp' } }));
    meals.set('m2', meal({ id: 'm2', assetIds: ['p2'], time: '12:55', estimate: estimate({ title: 'Soda', questions: [soda, size] }), answers: { q2: 'Large' } }));

    // Re-estimation fails, so the combined questions are what the user sees.
    jest.mocked(estimateAndReconcile).mockRejectedValueOnce(new Error('offline'));
    const merged = await mergeMeals('m1', 'm2');
    expect(merged.estimate?.questions.map((q) => [q.id, q.question])).toEqual([
      ['q1', 'How much oil?'],
      ['q2', 'Regular or diet soda?'],
      ['q3', 'Drink size?'],
    ]);
    expect(merged.answers).toEqual({ q1: '1 tbsp', q3: 'Large' });

    // Retrying sends each answer with its own question only.
    await reestimateMeal('m1');
    expect(jest.mocked(estimateAndReconcile).mock.calls.at(-1)?.[0].answers).toEqual([
      { question: 'How much oil?', answer: '1 tbsp' },
      { question: 'Drink size?', answer: 'Large' },
    ]);
  });

  it('lists a question both meals ask once, keeping whichever answer exists', () => {
    const oil = { id: 'q1', question: 'How much oil?', options: ['None', '1 tbsp'], affects: [] };
    const a = meal({ estimate: estimate({ questions: [oil] }) });
    const b = meal({ id: 'm2', estimate: estimate({ questions: [{ ...oil, question: 'how much oil' }] }), answers: { q1: 'None' } });
    expect(combineMeals(a, b, 'Lunch', NOW).questions).toEqual([oil]);
  });

  it('merging into a synced meal keeps its row tracked, so a later reject deletes it', async () => {
    photos.set('p1', photo('p1', at(28, 12, 30)));
    photos.set('p2', photo('p2', at(28, 12, 50)));
    meals.set('m1', meal({ status: 'synced' }));
    // b was synced once, then re-estimated back into review.
    meals.set('m2', meal({ id: 'm2', assetIds: ['p2'], time: '12:50', inSheet: true }));

    const merged = await mergeMeals('m1', 'm2');
    expect(merged).toMatchObject({ id: 'm1', status: 'needs_review', inSheet: true });
    expect(addPendingSheetDelete).toHaveBeenCalledWith('m2', 'meal');

    await rejectMeal('m1');
    expect(addPendingSheetDelete).toHaveBeenCalledWith('m1', 'meal');
  });

  it('saves nothing when a meal changed while the merge was re-estimating', async () => {
    photos.set('p1', photo('p1', at(28, 12, 30)));
    meals.set('m1', meal());
    meals.set('m2', meal({ id: 'm2', assetIds: [], estimate: null, title: 'Soda' }));
    jest.mocked(estimateAndReconcile).mockImplementation(async () => {
      meals.set('m2', { ...meals.get('m2')!, status: 'approved', updatedAt: 99 });
      return estimate();
    });
    const err = await mergeMeals('m1', 'm2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MealChangedError);
    expect((err as Error).message).toMatch(/changed while they were being merged/);
    expect(meals.get('m2')?.status).toBe('approved');
    expect(meals.get('m1')?.assetIds).toEqual(['p1']);
    expect(deleteMeal).not.toHaveBeenCalled();
  });

  it('keeps the merge with summed numbers when re-estimation fails', async () => {
    photos.set('p1', photo('p1', at(28, 12, 30)));
    jest.mocked(estimateAndReconcile).mockRejectedValue(new Error('Claude is temporarily unavailable'));
    meals.set('m1', meal());
    meals.set('m2', meal({ id: 'm2', assetIds: [], estimate: null, title: 'Soda', final: { kcal: 140, proteinG: 0, carbsG: 39, fatG: 0 } }));

    const m = await mergeMeals('m1', 'm2');

    expect(m.error).toBe('Claude is temporarily unavailable');
    expect(m.final).toEqual({ kcal: 650, proteinG: 40, carbsG: 99, fatG: 20 });
    expect(m.title).toBe('Chicken and rice + Soda');
    expect(m.estimate?.items.map((i) => i.name)).toEqual(['chicken', 'rice', 'Soda']);
    expect(meals.has('m2')).toBe(false);
    await expect(mergeMeals('m1', 'm1')).rejects.toThrow(/itself/);
  });

  it('saves a meal as a usual meal and links it', async () => {
    meals.set('m1', meal({ status: 'approved' }));
    await saveMealToLibrary('m1', ' Chicken & rice ', '1 bowl');
    expect(libraryItems).toEqual([
      {
        id: 'uuid-1',
        name: 'Chicken & rice',
        serving: '1 bowl',
        macros: { kcal: 510, proteinG: 40, carbsG: 60, fatG: 20 },
        aliases: ['Chicken and rice'],
        addedBy: 'Her',
        uses: 1,
        updatedAt: NOW,
        synced: false,
      },
    ]);
    expect(meals.get('m1')?.estimate?.libraryItemId).toBe('uuid-1');
  });

  it('updates a same-named usual meal instead of duplicating it', async () => {
    libraryItems = [
      { id: 'lib-1', name: 'Chicken & Rice', serving: 'plate', macros: { kcal: 1, proteinG: 1, carbsG: 1, fatG: 1 }, aliases: ['usual'], addedBy: 'Him', uses: 4, updatedAt: 1, synced: true },
    ];
    meals.set('m1', meal());
    await saveMealToLibrary('m1', 'chicken & rice', '');
    expect(libraryItems).toHaveLength(1);
    // A needs_review meal counts its use when approved.
    expect(libraryItems[0]).toMatchObject({ id: 'lib-1', name: 'Chicken & Rice', serving: 'plate', uses: 4, synced: false, aliases: ['usual', 'Chicken and rice'] });
    expect(meals.get('m1')?.estimate?.libraryItemId).toBe('lib-1');
    await expect(saveMealToLibrary('m1', '  ', '')).rejects.toThrow(/name/);
  });

  it("adds an approved meal's use to an existing usual meal as pending (not over the sheet's count)", async () => {
    libraryItems = [
      { id: 'lib-1', name: 'Oats', serving: 'jar', macros: { kcal: 1, proteinG: 1, carbsG: 1, fatG: 1 }, aliases: [], addedBy: 'Him', uses: 4, updatedAt: 1, synced: true },
    ];
    meals.set('m1', meal({ status: 'approved' }));
    await saveMealToLibrary('m1', 'oats', '');
    expect(libraryItems[0]).toMatchObject({ id: 'lib-1', uses: 4, pendingUses: 1, synced: false });
  });

  it('approves only confident entries', async () => {
    weights.set('w:Her:2026-09-28', weight());
    weights.set('w:Her:2026-09-27', weight({ id: 'w:Her:2026-09-27', localDate: '2026-09-27', flags: ['not_morning'] }));
    weights.set('w:Her:2026-09-26', weight({ id: 'w:Her:2026-09-26', localDate: '2026-09-26', confidence: 'medium' }));
    weights.set('w:Her:2026-09-25', weight({ id: 'w:Her:2026-09-25', localDate: '2026-09-25', status: 'approved' }));
    const q = { id: 'q1', question: 'Oil?', options: ['No', 'Yes'], affects: [] };
    meals.set('ok', meal({ id: 'ok' }));
    meals.set('answered', meal({ id: 'answered', estimate: estimate({ questions: [q] }), answers: { q1: 'No' } }));
    meals.set('question', meal({ id: 'question', estimate: estimate({ questions: [q] }) }));
    meals.set('flagged', meal({ id: 'flagged', estimate: estimate({ assumptions: ['check_portion:rice'] }) }));
    meals.set('medium', meal({ id: 'medium', estimate: estimate({ confidence: 'medium' }) }));
    meals.set('failed', meal({ id: 'failed', error: 'Claude failed' }));
    meals.set('manual', meal({ id: 'manual', estimate: null }));

    expect(await approveAllConfident()).toEqual({ weights: 1, meals: 2 });
    expect(weights.get('w:Her:2026-09-28')?.status).toBe('approved');
    expect(weights.get('w:Her:2026-09-27')?.status).toBe('needs_review');
    expect([...meals.values()].filter((m) => m.status === 'approved').map((m) => m.id).sort()).toEqual(['answered', 'ok']);
  });

  it('adds a manual meal as approved with method manual', async () => {
    const m = await addManualMeal('2026-09-28', '15:30', 'snack', ' Apple ', { kcal: 95, proteinG: 0.5, carbsG: 25, fatG: 0.3 }, '');
    expect(m).toEqual({
      id: 'uuid-1',
      person: 'Her',
      localDate: '2026-09-28',
      time: '15:30',
      slot: 'snack',
      assetIds: [],
      estimate: null,
      final: { kcal: 95, proteinG: 0.5, carbsG: 25, fatG: 0.3 },
      title: 'Apple',
      answers: {},
      notes: '',
      status: 'approved',
      error: null,
      updatedAt: NOW,
    });
    expect(meals.get('uuid-1')).toEqual(m);
    await expect(addManualMeal('2026-09-28', '3pm', 'snack', 'x', m.final, '')).rejects.toThrow(/13:45/);
    await expect(addManualMeal('2026-09-28', '15:00', 'snack', 'x', { ...m.final, kcal: -1 }, '')).rejects.toThrow(/zero or more/);
    // Same limits as the Apps Script, so an approved meal can never fail a whole sync batch.
    await expect(addManualMeal('2026-09-28', '15:00', 'snack', 'x', { ...m.final, kcal: 10_001 }, '')).rejects.toThrow(/10,000 kcal/);
    await expect(addManualMeal('2026-09-28', '15:00', 'snack', 'x', { ...m.final, carbsG: 2_001 }, '')).rejects.toThrow(/2,000 g/);
  });
});
