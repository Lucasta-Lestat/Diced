/// <reference types="jest" />
import { classifyBatch } from '../../ai/classify';
import { AiNotConfiguredError } from '../../ai/client';
import { estimateMeal } from '../../ai/food';
import { readScale, toPounds, type ScaleReading } from '../../ai/scale';
import { getSettings, updateSettings } from '../../config/settings';
import { listLibrary } from '../../db/library';
import { getMeal, listMeals, upsertMeal } from '../../db/meals';
import {
  getPhotos,
  insertNewPhotos,
  listPickedPhotos,
  listUnclassified,
  listUnprocessed,
  markProcessed,
  setClassification,
  setPhotoError,
} from '../../db/photos';
import { recordRun } from '../../db/runs';
import { listWeightEntries, recentAcceptedWeights, upsertWeightEntry } from '../../db/weights';
import { toLocalDate } from '../../lib/dates';
import { reconcileEstimate } from '../../nutrition/reconcile';
import { makeThumbnail, prepareForModel, prepareScaleImage, type PreparedImage } from '../../photos/images';
import { listPhotosInRange, resolveReadableUri } from '../../photos/scanner';
import { notifyReviewReady } from '../../scheduling/notifications';
import type {
  AppSettings,
  MealEntry,
  MealEstimate,
  PhotoAsset,
  PhotoRecord,
  ProcessProgress,
  ProcessResult,
  WeightEntry,
} from '../../types';
import {
  __resetProcessForTests,
  cancelProcessing,
  isProcessing,
  processCapturedPhoto,
  processPhotos,
  processPickedPhotos,
  subscribeProcessProgress,
} from '../process';

jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuid}` }));
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    create() {}
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get extension() {
      return /\.[a-z]+$/i.exec(this.uri)?.[0] ?? '';
    }
    async copy(dest: { uri: string }) {
      mockCopies.push({ from: this.uri, to: dest.uri });
    }
  }
  return { Directory, File, Paths: { document: new Directory('file:///docs') } };
});
jest.mock('../../config/settings', () => ({ getSettings: jest.fn(), updateSettings: jest.fn() }));
jest.mock('../../db/database', () => ({
  chunk: <T>(items: T[], size: number) =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size)),
}));
jest.mock('../../db/photos', () => ({
  getPhotos: jest.fn(),
  insertNewPhotos: jest.fn(),
  listPickedPhotos: jest.fn(),
  listUnclassified: jest.fn(),
  listUnprocessed: jest.fn(),
  markProcessed: jest.fn(),
  setClassification: jest.fn(),
  setPhotoError: jest.fn(),
}));
jest.mock('../../db/weights', () => ({
  listWeightEntries: jest.fn(),
  recentAcceptedWeights: jest.fn(),
  upsertWeightEntry: jest.fn(),
}));
jest.mock('../../db/meals', () => ({ getMeal: jest.fn(), listMeals: jest.fn(), upsertMeal: jest.fn() }));
jest.mock('../../db/library', () => ({ listLibrary: jest.fn() }));
jest.mock('../../db/runs', () => ({ recordRun: jest.fn() }));
jest.mock('../../photos/scanner', () => ({ listPhotosInRange: jest.fn(), resolveReadableUri: jest.fn() }));
jest.mock('../../photos/images', () => ({ makeThumbnail: jest.fn(), prepareForModel: jest.fn(), prepareScaleImage: jest.fn() }));
jest.mock('../../ai/classify', () => ({ classifyBatch: jest.fn() }));
jest.mock('../../ai/scale', () => ({ readScale: jest.fn(), toPounds: jest.fn() }));
jest.mock('../../ai/food', () => ({ estimateMeal: jest.fn() }));
jest.mock('../../ai/client', () => {
  class AiNotConfiguredError extends Error {}
  class AiApiError extends Error {
    kind: string;
    constructor(message: string, errorKind: string) {
      super(message);
      this.kind = errorKind;
    }
  }
  return { AiNotConfiguredError, AiApiError };
});
jest.mock('../../nutrition/reconcile', () => ({ reconcileEstimate: jest.fn() }));
jest.mock('../../scheduling/notifications', () => ({ notifyReviewReady: jest.fn() }));

let mockUuid = 0;
const mockCopies: { from: string; to: string }[] = [];

// Local wall-clock times (Sep 2026), so the tests hold in any time zone.
const at = (d: number, h: number, min = 0) => new Date(2026, 8, d, h, min).getTime();
const WINDOW = { startMs: at(21, 0), endMs: at(28, 12) };

const BASE: AppSettings = {
  person: 'Her',
  sheetWebAppUrl: 'https://script.google.com/macros/s/abc/exec',
  scheduleWeekday: 1,
  scheduleHour: 9,
  scheduleMinute: 0,
  processDaily: true,
  classificationMode: 'cloud_thumbnails',
  accuracyMode: 'standard',
  webLookupForRestaurants: true,
  plateDiameterIn: 10.5,
  scaleUnit: 'lb',
  mealGroupingMinutes: 20,
  morningCutoffHour: 11,
  model: 'claude-opus-5-5',
  lastScanEnd: null,
  lastAutoRunAt: null,
  onboardingComplete: true,
};

// ---------------------------------------------------------------------------
// In-memory stand-ins for the photo library and the SQLite tables
// ---------------------------------------------------------------------------

let settings: AppSettings;
let library: PhotoAsset[];
let photos: Map<string, PhotoRecord>;
let weights: Map<string, WeightEntry>;
let meals: Map<string, MealEntry>;
/** Asset id → category the fake classifier returns (default: from the id prefix). */
let categories: Record<string, PhotoRecord['category']>;
/** Asset id → scale reading (default: 185 lb, high). */
let readings: Record<string, ScaleReading | Error>;
let gone: Set<string>;

function asset(id: string, time: number, patch: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    id,
    uri: `ph://${id}`,
    creationTime: time,
    width: 3024,
    height: 4032,
    filename: `IMG_${id}.HEIC`,
    mediaSubtypes: [],
    origin: 'library',
    ...patch,
  };
}

function record(id: string, time: number, patch: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    assetId: id,
    uri: `ph://${id}`,
    creationTime: time,
    localDate: toLocalDate(time),
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

const idOf = (image: PreparedImage) => image.base64.replace(/^(thumb|full):/, '');

function mealEstimate(images: number): MealEstimate {
  return {
    title: `Meal from ${images} photo(s)`,
    items: [
      {
        name: 'pasta',
        portion: '1 plate',
        grams: 250,
        macros: { kcal: 400, proteinG: 14, carbsG: 70, fatG: 6 },
        source: 'model',
        confidence: 'high',
        usdaQuery: 'pasta cooked',
        fdcId: null,
        modelMacros: null,
      },
    ],
    totals: { kcal: 400, proteinG: 14, carbsG: 70, fatG: 6 },
    kcalLow: 320,
    kcalHigh: 520,
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
  };
}

const inRange = (p: PhotoRecord, start: number, end: number) =>
  p.creationTime >= start && p.creationTime < end && p.excludedReason === null;
const byTime = (a: PhotoRecord, b: PhotoRecord) => a.creationTime - b.creationTime;

function installFakes(): void {
  jest.mocked(getSettings).mockImplementation(async () => settings);
  jest.mocked(updateSettings).mockImplementation(async (patch) => (settings = { ...settings, ...patch }));

  jest.mocked(listPhotosInRange).mockImplementation(async (start, end) =>
    library.filter((a) => a.creationTime >= start && a.creationTime < end),
  );
  jest.mocked(resolveReadableUri).mockImplementation(async (id, uri) => (gone.has(id) ? null : uri));
  jest.mocked(makeThumbnail).mockImplementation(async (uri) => ({ base64: `thumb:${uri.replace('ph://', '')}`, mediaType: 'image/jpeg', width: 384, height: 512 }));
  jest.mocked(prepareForModel).mockImplementation(async (uri) => ({
    base64: `full:${uri.replace('ph://', '').replace(/^file:\/\/\/docs\/captures\/(.*)\.jpg$/, 'capture:$1')}`,
    mediaType: 'image/jpeg',
    width: 1176,
    height: 1568,
  }));
  jest.mocked(prepareScaleImage).mockImplementation(async (uri) => ({
    base64: `full:${uri.replace('ph://', '').replace(/^file:\/\/\/docs\/captures\/(.*)\.jpg$/, 'capture:$1')}`,
    mediaType: 'image/jpeg',
    width: 1677,
    height: 2236,
  }));

  jest.mocked(insertNewPhotos).mockImplementation(async (records) => {
    let n = 0;
    for (const r of records) {
      if (photos.has(r.assetId)) continue;
      photos.set(r.assetId, { ...r });
      n++;
    }
    return n;
  });
  jest.mocked(getPhotos).mockImplementation(async (ids) => ids.flatMap((id) => (photos.has(id) ? [{ ...photos.get(id)! }] : [])));
  jest.mocked(listPickedPhotos).mockImplementation(async (start, end) =>
    [...photos.values()].filter((p) => p.assetId.startsWith('picked:') && p.creationTime >= start && p.creationTime <= end).sort(byTime),
  );
  jest.mocked(listUnclassified).mockImplementation(async (start, end) =>
    [...photos.values()].filter((p) => inRange(p, start, end) && p.category === null).sort(byTime),
  );
  jest.mocked(listUnprocessed).mockImplementation(async (start, end, cats) =>
    [...photos.values()]
      .filter((p) => inRange(p, start, end) && p.category !== null && cats.includes(p.category) && p.processedAt === null)
      .sort(byTime),
  );
  jest.mocked(setClassification).mockImplementation(async (id, category, confidence) => {
    const p = photos.get(id);
    if (p) Object.assign(p, { category, categoryConfidence: confidence, classifiedAt: 1 });
  });
  jest.mocked(markProcessed).mockImplementation(async (ids) => {
    for (const id of ids) Object.assign(photos.get(id) ?? {}, { processedAt: 1, error: null });
  });
  jest.mocked(setPhotoError).mockImplementation(async (id, error) => {
    const p = photos.get(id);
    if (p) p.error = error;
  });

  jest.mocked(listWeightEntries).mockImplementation(async (filter) =>
    [...weights.values()].filter(
      (e) => (!filter?.from || e.localDate >= filter.from) && (!filter?.to || e.localDate <= filter.to),
    ),
  );
  jest.mocked(recentAcceptedWeights).mockResolvedValue([]);
  jest.mocked(upsertWeightEntry).mockImplementation(async (e) => void weights.set(e.id, e));
  jest.mocked(upsertMeal).mockImplementation(async (m) => void meals.set(m.id, m));
  jest.mocked(getMeal).mockImplementation(async (id) => meals.get(id) ?? null);
  jest.mocked(listMeals).mockImplementation(async (filter) =>
    [...meals.values()].filter(
      (m) =>
        (!filter?.person || m.person === filter.person) &&
        (!filter?.statuses || filter.statuses.includes(m.status)) &&
        (!filter?.from || m.localDate >= filter.from) &&
        (!filter?.to || m.localDate <= filter.to),
    ),
  );
  jest.mocked(listLibrary).mockResolvedValue([]);
  jest.mocked(recordRun).mockResolvedValue(undefined);
  jest.mocked(notifyReviewReady).mockResolvedValue(undefined);

  jest.mocked(classifyBatch).mockImplementation(async (inputs) =>
    Object.fromEntries(
      inputs.map((i) => {
        const id = i.assetId;
        const category = categories[id] ?? (id.startsWith('scale') ? 'scale' : id.startsWith('food') ? 'food' : 'other');
        return [id, { category: category ?? 'other', confidence: 1 }];
      }),
    ),
  );
  jest.mocked(readScale).mockImplementation(async (image) => {
    const r = readings[idOf(image)];
    if (r instanceof Error) throw r;
    return r ?? { isScale: true, value: 185, unit: 'lb', confidence: 'high', issues: [] };
  });
  jest.mocked(toPounds).mockImplementation((v, unit) => (unit === 'kg' ? v * 2.20462 : v));
  jest.mocked(estimateMeal).mockImplementation(async (input) => mealEstimate(input.images.length));
  jest.mocked(reconcileEstimate).mockImplementation(async (e) => e);
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetProcessForTests();
  settings = { ...BASE };
  library = [];
  photos = new Map();
  weights = new Map();
  meals = new Map();
  categories = {};
  readings = {};
  gone = new Set();
  mockUuid = 0;
  mockCopies.length = 0;
  installFakes();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('processPhotos (cloud mode)', () => {
  beforeEach(() => {
    library = [
      asset('scale-1', at(27, 7, 5)),
      asset('food-1', at(27, 12, 30)),
      asset('food-2', at(27, 12, 42)),
      asset('food-3', at(27, 19, 10)),
      asset('shot-1', at(27, 13), { filename: 'Screenshot_20260927-130000.png' }),
      asset('cat-1', at(26, 18)),
    ];
  });

  it('scans, classifies, reads the scale, estimates meals and records the run', async () => {
    const progress: ProcessProgress[] = [];
    const result = await processPhotos({ reason: 'weekly', window: WINDOW, onProgress: (p) => progress.push(p) });

    expect(result).toEqual({
      reason: 'weekly',
      windowStart: WINDOW.startMs,
      windowEnd: WINDOW.endMs,
      photosScanned: 6,
      photosExcluded: 1,
      photosClassified: 5,
      scalePhotos: 1,
      foodPhotos: 3,
      weightEntriesCreated: 1,
      mealsCreated: 2,
      errors: [],
      partial: false,
    });

    // The screenshot is never sent anywhere.
    expect(photos.get('shot-1')?.excludedReason).toBe('screenshot');
    const sent = jest.mocked(classifyBatch).mock.calls.flatMap(([inputs]) => inputs.map((i) => i.assetId));
    expect(sent).not.toContain('shot-1');
    // Model confidences stay below the "user chose it" marker.
    expect(photos.get('food-1')?.categoryConfidence).toBe(0.99);

    const weight = weights.get('w:Her:2026-09-27');
    expect(weight).toMatchObject({ valueLb: 185, time: '07:05', status: 'needs_review', chosenAssetId: 'scale-1' });
    expect(jest.mocked(readScale).mock.calls[0][1]).toEqual({ expectedUnit: 'lb', recentLb: null });

    const saved = [...meals.values()].sort((a, b) => a.time.localeCompare(b.time));
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      person: 'Her',
      localDate: '2026-09-27',
      time: '12:30',
      slot: 'lunch',
      assetIds: ['food-1', 'food-2'],
      title: 'Meal from 2 photo(s)',
      final: { kcal: 400, proteinG: 14, carbsG: 70, fatG: 6 },
      status: 'needs_review',
      answers: {},
      notes: '',
      error: null,
    });
    expect(saved[0].id).toMatch(/^uuid-/);
    expect(saved[1]).toMatchObject({ slot: 'dinner', assetIds: ['food-3'] });
    // Meals are estimated concurrently; pick the lunch request by its photos.
    const input = jest.mocked(estimateMeal).mock.calls.map(([i]) => i).find((i) => i.images.length === 2);
    expect(input).toMatchObject({ slot: 'lunch', notes: '', answers: [], plateDiameterIn: 10.5, accuracyMode: 'standard' });
    expect(jest.mocked(reconcileEstimate)).toHaveBeenCalledWith(expect.anything(), {
      useUsda: true,
      webLookupForRestaurants: true,
      userContext: false,
      signal: expect.any(AbortSignal),
    });

    expect([...photos.values()].filter((p) => p.processedAt !== null).map((p) => p.assetId).sort()).toEqual([
      'food-1',
      'food-2',
      'food-3',
      'scale-1',
    ]);
    expect(settings.lastScanEnd).toBe(WINDOW.endMs);
    expect(recordRun).toHaveBeenCalledWith(expect.any(Number), result);
    expect(notifyReviewReady).toHaveBeenCalledWith(1, 2);
    expect(new Set(progress.map((p) => p.stage))).toEqual(
      new Set(['scanning', 'classifying', 'reading_scale', 'estimating_meals', 'saving', 'done']),
    );
    expect(progress[progress.length - 1].stage).toBe('done');
  });

  it('sends at most 4 photos per meal (first, last, evenly spaced)', async () => {
    library = Array.from({ length: 7 }, (_, i) => asset(`food-${i}`, at(27, 12, i * 5)));
    await processPhotos({ reason: 'manual', window: WINDOW });
    const images = jest.mocked(estimateMeal).mock.calls[0][0].images;
    expect(images.map((i) => idOf(i.image))).toEqual(['food-0', 'food-2', 'food-4', 'food-6']);
    expect(meals.size).toBe(1);
    expect([...meals.values()][0].assetIds).toHaveLength(7);
    expect(notifyReviewReady).not.toHaveBeenCalled();
  });

  it('classifies in batches of 16 with at most 2 requests in flight', async () => {
    library = Array.from({ length: 40 }, (_, i) => asset(`other-${i}`, at(22, 8) + i * 60_000));
    let inFlight = 0;
    let maxInFlight = 0;
    const real = jest.mocked(classifyBatch).getMockImplementation()!;
    jest.mocked(classifyBatch).mockImplementation(async (inputs, opts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return real(inputs, opts);
    });
    const result = await processPhotos({ reason: 'manual', window: WINDOW });
    expect(jest.mocked(classifyBatch).mock.calls.map(([inputs]) => inputs.length)).toEqual([16, 16, 8]);
    expect(maxInFlight).toBe(2);
    expect(result.photosClassified).toBe(40);
  });

  it('keeps going when one photo fails and records the error on it', async () => {
    library.push(asset('scale-2', at(26, 7)));
    readings['scale-2'] = new Error('Display unreadable');
    const result = await processPhotos({ reason: 'manual', window: WINDOW });

    expect(result.partial).toBe(false);
    expect(result.errors).toEqual([expect.stringMatching(/Display unreadable$/)]);
    expect(photos.get('scale-2')).toMatchObject({ processedAt: null, error: 'Display unreadable' });
    expect(weights.has('w:Her:2026-09-27')).toBe(true);
    expect(weights.has('w:Her:2026-09-26')).toBe(false);
    expect(result.mealsCreated).toBe(2);
    expect(settings.lastScanEnd).toBe(WINDOW.endMs);
  });

  it('retries photos that failed in an earlier run', async () => {
    readings['scale-1'] = new Error('Overloaded');
    await processPhotos({ reason: 'manual', window: WINDOW });
    expect(weights.size).toBe(0);

    delete readings['scale-1'];
    const next = await processPhotos({ reason: 'manual', window: { startMs: WINDOW.endMs, endMs: at(28, 18) } });
    expect(next.scalePhotos).toBe(1);
    expect(weights.get('w:Her:2026-09-27')?.valueLb).toBe(185);
  });

  it('marks deleted photos processed without calling Claude', async () => {
    library = [asset('scale-1', at(27, 7))];
    await processPhotos({ reason: 'manual', window: WINDOW });
    // Deleted after classification, before the scale was read.
    photos.get('scale-1')!.processedAt = null;
    gone.add('scale-1');
    jest.mocked(readScale).mockClear();
    await processPhotos({ reason: 'manual', window: WINDOW });
    expect(readScale).not.toHaveBeenCalled();
    expect(photos.get('scale-1')).toMatchObject({ error: 'Photo no longer available' });
    expect(photos.get('scale-1')?.processedAt).not.toBeNull();
  });

  it('never overwrites an approved weigh-in', async () => {
    const approved: WeightEntry = {
      id: 'w:Her:2026-09-27',
      person: 'Her',
      localDate: '2026-09-27',
      time: null,
      valueLb: 184,
      chosenAssetId: null,
      source: 'manual',
      confidence: 'high',
      candidates: [],
      flags: [],
      notes: '',
      status: 'synced',
      syncError: null,
      updatedAt: 7,
    };
    weights.set(approved.id, approved);
    const result = await processPhotos({ reason: 'manual', window: WINDOW });
    expect(result.weightEntriesCreated).toBe(0);
    expect(weights.get(approved.id)).toMatchObject({ valueLb: 184, status: 'synced', updatedAt: 7 });
    expect(weights.get(approved.id)?.candidates.map((c) => c.assetId)).toEqual(['scale-1']);
  });

  it('stops starting work when the time budget runs out and does not advance lastScanEnd', async () => {
    settings.lastScanEnd = WINDOW.startMs;
    library = Array.from({ length: 40 }, (_, i) => asset(`food-${i}`, at(22, 8) + i * 3_600_000));
    let clock = at(28, 12);
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const real = jest.mocked(classifyBatch).getMockImplementation()!;
    jest.mocked(classifyBatch).mockImplementation(async (inputs, opts) => {
      clock += 20_000;
      return real(inputs, opts);
    });

    const result = await processPhotos({ reason: 'background', timeBudgetMs: 25_000 });

    expect(result.partial).toBe(true);
    expect(jest.mocked(classifyBatch).mock.calls.length).toBe(2);
    expect(result.photosClassified).toBe(32);
    // Meals wait until every photo is sorted, so a meal is never split across runs.
    expect(estimateMeal).not.toHaveBeenCalled();
    expect(settings.lastScanEnd).toBe(WINDOW.startMs);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith(expect.any(Number), result);
  });

  it('honours the abort signal', async () => {
    const controller = new AbortController();
    jest.mocked(classifyBatch).mockImplementationOnce(async (inputs) => {
      controller.abort();
      return Object.fromEntries(inputs.map((i) => [i.assetId, { category: 'food' as const, confidence: 0.9 }]));
    });
    const result = await processPhotos({ reason: 'deeplink', window: WINDOW, signal: controller.signal });
    expect(result.partial).toBe(true);
    expect(readScale).not.toHaveBeenCalled();
    expect(estimateMeal).not.toHaveBeenCalled();
    expect(settings.lastScanEnd).toBeNull();
  });

  it('stops calling Claude after a run-stopping error (no API key)', async () => {
    jest.mocked(readScale).mockRejectedValue(new AiNotConfiguredError('Add your Claude API key in Settings first.'));
    library = [asset('scale-1', at(27, 7)), asset('scale-2', at(27, 7, 30)), asset('scale-3', at(27, 8)), asset('scale-4', at(27, 9)), asset('food-1', at(27, 12))];
    const result = await processPhotos({ reason: 'manual', window: WINDOW });
    expect(result.partial).toBe(true);
    expect(jest.mocked(readScale).mock.calls.length).toBeLessThanOrEqual(3);
    expect(estimateMeal).not.toHaveBeenCalled();
    expect(result.errors).toContainEqual(expect.stringMatching(/API key/));
  });

  it('is single-flight', async () => {
    const first = processPhotos({ reason: 'manual', window: WINDOW });
    const second = processPhotos({ reason: 'weekly', window: WINDOW });
    expect(isProcessing()).toBe(true);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.reason).toBe('manual');
    expect(listPhotosInRange).toHaveBeenCalledTimes(1);
    expect(isProcessing()).toBe(false);
  });

  it('lets a caller that joined a running run follow its progress and stop it', async () => {
    const joinerProgress: ProcessProgress[] = [];
    const joiner = new AbortController();
    let second: Promise<ProcessResult> | null = null;
    jest.mocked(classifyBatch).mockImplementationOnce(async (inputs) => {
      // The background task started the run; the process-week screen joins it, then cancels.
      second = processPhotos({ reason: 'deeplink', signal: joiner.signal, onProgress: (p) => joinerProgress.push(p) });
      joiner.abort();
      return Object.fromEntries(inputs.map((i) => [i.assetId, { category: 'food' as const, confidence: 0.9 }]));
    });
    const first = processPhotos({ reason: 'background', window: WINDOW });
    const result = await first;
    expect(await second).toBe(result);
    expect(result.partial).toBe(true);
    expect(estimateMeal).not.toHaveBeenCalled();
    expect(joinerProgress.length).toBeGreaterThan(0);
  });

  it('cancelProcessing stops the in-flight run and reports progress to subscribers', async () => {
    const seen: ProcessProgress[] = [];
    const unsubscribe = subscribeProcessProgress((p) => seen.push(p));
    jest.mocked(classifyBatch).mockImplementationOnce(async (inputs) => {
      expect(cancelProcessing()).toBe(true);
      return Object.fromEntries(inputs.map((i) => [i.assetId, { category: 'food' as const, confidence: 0.9 }]));
    });
    const result = await processPhotos({ reason: 'manual', window: WINDOW });
    unsubscribe();
    expect(result.partial).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(cancelProcessing()).toBe(false);
  });

  it('requires a person', async () => {
    settings.person = null;
    await expect(processPhotos({ reason: 'manual', window: WINDOW })).rejects.toThrow(/Her or Him/);
    expect(isProcessing()).toBe(false);
  });

  it('uses the default window from lastScanEnd', async () => {
    settings.lastScanEnd = at(27, 0);
    jest.spyOn(Date, 'now').mockReturnValue(at(28, 12));
    const result = await processPhotos({ reason: 'manual' });
    expect(result.windowStart).toBe(at(27, 0));
    expect(result.windowEnd).toBe(at(28, 12));
    expect(result.photosScanned).toBe(5);
    expect(settings.lastScanEnd).toBe(at(28, 12));
  });
});

describe('processPhotos (manual mode)', () => {
  it('scans nothing and only processes photos whose category the user chose', async () => {
    settings.classificationMode = 'manual';
    library = [asset('food-1', at(27, 12))];
    photos.set('picked', record('picked', at(27, 8), { category: 'food', categoryConfidence: 1 }));
    photos.set('capture:1', record('capture:1', at(27, 19), { category: 'scale', categoryConfidence: 1, origin: 'capture' }));
    photos.set('model', record('model', at(27, 13), { category: 'food', categoryConfidence: 0.95 }));
    photos.set('unsorted', record('unsorted', at(27, 14)));

    const result = await processPhotos({ reason: 'manual', window: WINDOW });

    expect(listPhotosInRange).not.toHaveBeenCalled();
    expect(classifyBatch).not.toHaveBeenCalled();
    expect(makeThumbnail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ photosScanned: 0, scalePhotos: 1, foodPhotos: 1, mealsCreated: 1, weightEntriesCreated: 1, partial: false });
    expect([...meals.values()][0].assetIds).toEqual(['picked']);
    expect(photos.get('model')?.processedAt).toBeNull();
    expect(weights.get('w:Her:2026-09-27')?.source).toBe('capture');
    expect(settings.lastScanEnd).toBe(WINDOW.endMs);
  });
});

describe('processCapturedPhoto', () => {
  it('stores a scale photo in the app documents and returns the day entry', async () => {
    const out = await processCapturedPhoto('file:///cache/ImagePicker/abc.jpg', 'scale', at(28, 7, 12));
    expect(out).toEqual({ kind: 'weight', id: 'w:Her:2026-09-28' });
    expect(mockCopies).toEqual([{ from: 'file:///cache/ImagePicker/abc.jpg', to: 'file:///docs/captures/uuid-1.jpg' }]);
    expect(photos.get('capture:uuid-1')).toMatchObject({
      origin: 'capture',
      uri: 'file:///docs/captures/uuid-1.jpg',
      category: 'scale',
      categoryConfidence: 1,
      localDate: '2026-09-28',
      error: null,
    });
    expect(photos.get('capture:uuid-1')?.processedAt).not.toBeNull();
    expect(weights.get('w:Her:2026-09-28')).toMatchObject({ source: 'capture', time: '07:12', status: 'needs_review' });
    expect(isProcessing()).toBe(false);
  });

  it('estimates a meal photo and returns the meal id', async () => {
    const out = await processCapturedPhoto('file:///cache/ImagePicker/lunch.jpg', 'food', at(28, 12, 5));
    expect(out.kind).toBe('meal');
    expect(meals.get(out.id)).toMatchObject({ assetIds: ['capture:uuid-1'], slot: 'lunch', time: '12:05', status: 'needs_review' });
  });

  it('throws a helpful error when no weight can be read and keeps the photo out of the retry queue', async () => {
    readings['capture:uuid-1'] = { isScale: false, value: null, unit: null, confidence: 'low', issues: ['no display'] };
    await expect(processCapturedPhoto('file:///cache/x.jpg', 'scale', at(28, 7))).rejects.toThrow(/Couldn't read a weight/);
    expect(photos.get('capture:uuid-1')?.processedAt).not.toBeNull();
    expect(photos.get('capture:uuid-1')?.error).toMatch(/Couldn't read a weight/);
    expect(weights.size).toBe(0);
  });

  it('leaves the photo for the next run when Claude fails', async () => {
    readings['capture:uuid-1'] = new Error('Claude is temporarily unavailable');
    await expect(processCapturedPhoto('file:///cache/x.jpg', 'scale', at(28, 7))).rejects.toThrow(/temporarily/);
    expect(photos.get('capture:uuid-1')).toMatchObject({ processedAt: null, error: 'Claude is temporarily unavailable' });
  });

  it("doesn't leave a failed meal photo for a later run (a retake would log the food twice)", async () => {
    jest.mocked(estimateMeal).mockRejectedValueOnce(new Error("Couldn't reach Claude — check your internet connection."));
    await expect(processCapturedPhoto('file:///cache/lunch.jpg', 'food', at(28, 12, 5))).rejects.toThrow(
      /internet connection\. Nothing was logged — take the photo again or type the meal in\.$/,
    );
    expect(photos.get('capture:uuid-1')?.processedAt).not.toBeNull();
    expect(photos.get('capture:uuid-1')?.error).toMatch(/Nothing was logged/);

    // The retake succeeds; the next run doesn't turn the failed first shot into a second meal.
    const retake = await processCapturedPhoto('file:///cache/lunch2.jpg', 'food', at(28, 12, 6));
    await processPhotos({ reason: 'manual', window: WINDOW });
    expect([...meals.keys()]).toEqual([retake.id]);
    expect(estimateMeal).toHaveBeenCalledTimes(2);
  });

  it('adds another shot of a meal still in review to that meal and returns it', async () => {
    const first = await processCapturedPhoto('file:///cache/lunch.jpg', 'food', at(28, 12, 0));
    const second = await processCapturedPhoto('file:///cache/lunch-after.jpg', 'food', at(28, 12, 15));
    expect(second).toEqual(first);
    expect(meals.size).toBe(1);
    expect(meals.get(first.id)?.assetIds).toEqual(['capture:uuid-1', 'capture:uuid-3']);
    expect(photos.get('capture:uuid-3')?.processedAt).not.toBeNull();
  });

  it('adds a leftovers-only capture to the meal eaten up to 90 minutes earlier', async () => {
    const dinner = await processCapturedPhoto('file:///cache/dinner.jpg', 'food', at(28, 18, 30));
    jest.mocked(estimateMeal).mockImplementation(async (input) => {
      const ids = input.images.map((i) => idOf(i.image));
      return { ...mealEstimate(ids.length), ...(ids.length === 1 && ids[0] !== 'capture:uuid-1' ? { leftoversOnly: true } : {}) };
    });
    const after = await processCapturedPhoto('file:///cache/plate.jpg', 'food', at(28, 19, 45));
    expect(after).toEqual(dinner);
    expect(meals.get(dinner.id)?.assetIds).toEqual(['capture:uuid-1', 'capture:uuid-3']);
  });

  it('keeps its own guidance when no food is found', async () => {
    jest.mocked(estimateMeal).mockResolvedValueOnce({ ...mealEstimate(1), items: [], totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 } });
    await expect(processCapturedPhoto('file:///cache/desk.jpg', 'food', at(28, 12))).rejects.toThrow(
      /^Couldn't find any food in that photo — retake it or type the meal in\.$/,
    );
    expect(photos.get('capture:uuid-1')?.processedAt).not.toBeNull();
  });
});

describe('processPickedPhotos', () => {
  it('stores picked photos with their category and groups them into meals', async () => {
    const picked = [
      { assetId: 'a', uri: 'ph://a', creationTime: at(20, 18, 0) },
      { assetId: 'b', uri: 'ph://b', creationTime: at(20, 18, 10) },
    ];
    const result = await processPickedPhotos(picked, 'food');
    expect(result).toMatchObject({ reason: 'manual', photosScanned: 2, foodPhotos: 2, mealsCreated: 1, errors: [] });
    expect(photos.get('a')).toMatchObject({ category: 'food', categoryConfidence: 1, origin: 'library' });
    expect([...meals.values()][0]).toMatchObject({ assetIds: ['a', 'b'], slot: 'dinner' });
    expect(recordRun).toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('re-labels known photos and skips photos already in a logged meal', async () => {
    photos.set('a', record('a', at(20, 8), { category: 'other', categoryConfidence: 0.7, processedAt: 5 }));
    photos.set('b', record('b', at(20, 12)));
    const existing: MealEntry = {
      id: 'm1',
      person: 'Her',
      localDate: '2026-09-20',
      time: '12:00',
      slot: 'lunch',
      assetIds: ['b'],
      estimate: null,
      final: { kcal: 500, proteinG: 20, carbsG: 50, fatG: 20 },
      title: 'Lunch',
      answers: {},
      notes: '',
      status: 'synced',
      error: null,
      updatedAt: 1,
    };
    meals.set('m1', existing);
    const result = await processPickedPhotos(
      [
        { assetId: 'a', uri: 'ph://a', creationTime: at(20, 8) },
        { assetId: 'b', uri: 'ph://b', creationTime: at(20, 12) },
      ],
      'food',
    );
    expect(photos.get('a')?.category).toBe('food');
    expect(result.mealsCreated).toBe(1);
    expect(result.errors).toEqual(['1 photo(s) are already part of a logged meal.']);
    const created = [...meals.values()].find((m) => m.id !== 'm1');
    expect(created?.assetIds).toEqual(['a']);
  });

  it('reads picked scale photos at full model resolution', async () => {
    const result = await processPickedPhotos([{ assetId: 'ph://s', uri: 'ph://s', creationTime: at(19, 6, 50) }], 'scale');
    expect(result.weightEntriesCreated).toBe(1);
    expect(weights.get('w:Her:2026-09-19')?.valueLb).toBe(185);
    expect(prepareScaleImage).toHaveBeenCalledWith('ph://s');
    expect(prepareForModel).not.toHaveBeenCalled();
  });

  it("keeps its own copy of a pick without a library id (the picker's copy is in the purgeable cache)", async () => {
    const result = await processPickedPhotos(
      [
        { assetId: 'picked:IMG_7.jpg', uri: 'file:///cache/ImagePicker/7.jpg', creationTime: at(20, 12, 0) },
        { assetId: 'ph://lib-8', uri: 'file:///cache/ImagePicker/8.jpg', creationTime: at(20, 12, 5) },
      ],
      'food',
    );
    expect(result.mealsCreated).toBe(1);
    expect(mockCopies).toEqual([{ from: 'file:///cache/ImagePicker/7.jpg', to: 'file:///docs/picked/uuid-1.jpg' }]);
    expect(photos.get('picked:IMG_7.jpg')?.uri).toBe('file:///docs/picked/uuid-1.jpg');
    // A library photo can be read from the library again if its cache copy disappears.
    expect(photos.get('ph://lib-8')?.uri).toBe('file:///cache/ImagePicker/8.jpg');
  });

  it('a later scan skips the library copy of a photo picked without a library id', async () => {
    await processPickedPhotos([{ assetId: 'picked:IMG_7.jpg', uri: 'file:///cache/ImagePicker/7.jpg', creationTime: at(27, 12, 0) }], 'food');
    expect(meals.size).toBe(1);
    library = [
      asset('food-7', at(27, 12, 0) + 1000, { filename: 'img_7.JPG' }), // the same photo, found by the scan
      asset('food-8', at(27, 19, 0), { filename: 'IMG_7.jpg' }), // same name, another time: another photo
    ];
    const result = await processPhotos({ reason: 'weekly', window: WINDOW });
    expect(photos.has('food-7')).toBe(false);
    expect(result).toMatchObject({ photosScanned: 1, mealsCreated: 1 });
    expect([...meals.values()].map((m) => m.assetIds)).toEqual([['picked:IMG_7.jpg'], ['food-8']]);
  });
});

describe('meals spread over runs', () => {
  const inReview = (id: string, assetIds: string[], time: string, patch: Partial<MealEntry> = {}): MealEntry => ({
    id,
    person: 'Her',
    localDate: '2026-09-27',
    time,
    slot: 'lunch',
    assetIds,
    estimate: mealEstimate(assetIds.length),
    final: { kcal: 400, proteinG: 14, carbsG: 70, fatG: 6 },
    title: 'Meal from 1 photo(s)',
    answers: {},
    notes: '',
    status: 'needs_review',
    error: null,
    updatedAt: 3,
    ...patch,
  });
  const processedFood = (id: string, time: number) =>
    record(id, time, { category: 'food', categoryConfidence: 0.99, classifiedAt: 1, processedAt: 2 });
  /** estimateMeal answers "leftovers only" when every photo sent is one of `after`. */
  const leftoversFor = (...after: string[]) =>
    jest.mocked(estimateMeal).mockImplementation(async (input) => {
      const ids = input.images.map((i) => idOf(i.image));
      const only = ids.every((id) => after.includes(id));
      return { ...mealEstimate(ids.length), ...(only ? { leftoversOnly: true } : {}) };
    });

  it('adds a later photo of the same meal to the meal still in review instead of making a second meal', async () => {
    photos.set('food-1', processedFood('food-1', at(27, 12, 30)));
    meals.set('m1', inReview('m1', ['food-1'], '12:30', { notes: 'no dressing' }));
    library = [asset('food-2', at(27, 12, 45))];

    const result = await processPhotos({ reason: 'manual', window: WINDOW });

    expect(result.mealsCreated).toBe(0);
    expect([...meals.keys()]).toEqual(['m1']);
    expect(meals.get('m1')).toMatchObject({ assetIds: ['food-1', 'food-2'], status: 'needs_review', time: '12:30', notes: 'no dressing', updatedAt: expect.any(Number) });
    const input = jest.mocked(estimateMeal).mock.calls[0][0];
    expect(input.images.map((i) => idOf(i.image))).toEqual(['food-1', 'food-2']);
    expect(input.notes).toBe('no dressing');
    expect(photos.get('food-2')?.processedAt).not.toBeNull();
  });

  it('starts a new meal when the earlier one was already approved', async () => {
    photos.set('food-1', processedFood('food-1', at(27, 12, 30)));
    meals.set('m1', inReview('m1', ['food-1'], '12:30', { status: 'approved' }));
    library = [asset('food-2', at(27, 12, 45))];
    const result = await processPhotos({ reason: 'manual', window: WINDOW });
    expect(result.mealsCreated).toBe(1);
    expect(meals.get('m1')?.assetIds).toEqual(['food-1']);
  });

  it('leaves a meal photographed minutes ago for the next automatic run', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(at(27, 12, 40));
    library = [asset('food-1', at(27, 12, 30)), asset('food-old', at(27, 8, 0))];

    const result = await processPhotos({ reason: 'daily', window: { startMs: at(27, 0), endMs: at(27, 12, 40) } });

    expect(result.mealsCreated).toBe(1);
    expect(result.foodPhotos).toBe(1);
    expect(photos.get('food-1')?.processedAt).toBeNull();
    expect(photos.get('food-old')?.processedAt).not.toBeNull();
    // Tapping "Process new photos" doesn't wait.
    await processPhotos({ reason: 'manual', window: { startMs: at(27, 12, 40), endMs: at(27, 12, 41) } });
    expect(photos.get('food-1')?.processedAt).not.toBeNull();
  });

  it('holds back only the meal next to a photo that failed to sort for the first time', async () => {
    photos.set('food-1', record('food-1', at(27, 12, 30), { category: 'food', categoryConfidence: 0.99, classifiedAt: 1 }));
    photos.set('food-9', record('food-9', at(27, 19, 0), { category: 'food', categoryConfidence: 0.99, classifiedAt: 1 }));
    photos.set('new-2', record('new-2', at(27, 12, 40)));
    photos.set('old-3', record('old-3', at(27, 19, 5), { error: 'failed last run' }));
    jest.mocked(classifyBatch).mockRejectedValue(new Error('Claude API error 500: oops'));

    const result = await processPhotos({ reason: 'manual', window: WINDOW });

    // Lunch waits for its unsorted neighbour; dinner's neighbour already failed in an earlier run
    // (a photo that keeps failing must not block its meal forever), so dinner goes ahead.
    expect(result.mealsCreated).toBe(1);
    expect(photos.get('food-1')?.processedAt).toBeNull();
    expect(photos.get('food-9')?.processedAt).not.toBeNull();
    expect(result.foodPhotos).toBe(1);

    // Next run the neighbour has failed once already: lunch no longer waits.
    const next = await processPhotos({ reason: 'manual', window: WINDOW });
    expect(next.mealsCreated).toBe(1);
    expect(photos.get('food-1')?.processedAt).not.toBeNull();
  });

  it('adds a leftovers-only "after" photo to the earlier meal in the same run', async () => {
    library = [asset('food-dinner', at(27, 19, 0)), asset('food-after', at(27, 19, 40))];
    leftoversFor('food-after');

    const result = await processPhotos({ reason: 'manual', window: WINDOW });

    expect(result.mealsCreated).toBe(1);
    const [meal] = [...meals.values()];
    expect(meal.assetIds).toEqual(['food-dinner', 'food-after']);
    expect(meal.time).toBe('19:00');
    const sent = jest.mocked(estimateMeal).mock.calls.map(([i]) => i.images.map((x) => idOf(x.image)));
    expect(sent).toContainEqual(['food-dinner', 'food-after']);
    expect(photos.get('food-after')?.processedAt).not.toBeNull();
  });

  it('adds a leftovers-only photo to a meal from an earlier run up to 90 minutes before it', async () => {
    photos.set('food-1', processedFood('food-1', at(27, 18, 0)));
    meals.set('m1', inReview('m1', ['food-1'], '18:00', { slot: 'dinner' }));
    library = [asset('food-after', at(27, 19, 20))];
    leftoversFor('food-after');

    const result = await processPhotos({ reason: 'manual', window: WINDOW });

    expect(result.mealsCreated).toBe(0);
    expect(meals.get('m1')?.assetIds).toEqual(['food-1', 'food-after']);
  });

  it('keeps a leftovers-only photo as its own meal when no earlier meal is in review', async () => {
    library = [asset('food-after', at(27, 19, 20))];
    leftoversFor('food-after');
    const result = await processPhotos({ reason: 'manual', window: WINDOW });
    expect(result.mealsCreated).toBe(1);
    expect([...meals.values()][0].assetIds).toEqual(['food-after']);
  });

  it("doesn't overwrite a meal the user changed while the photos were being added", async () => {
    photos.set('food-1', processedFood('food-1', at(27, 12, 30)));
    meals.set('m1', inReview('m1', ['food-1'], '12:30'));
    library = [asset('food-2', at(27, 12, 45))];
    jest.mocked(estimateMeal).mockImplementationOnce(async (input) => {
      meals.set('m1', { ...meals.get('m1')!, status: 'approved', updatedAt: 50 });
      return mealEstimate(input.images.length);
    });

    const result = await processPhotos({ reason: 'manual', window: WINDOW });

    expect(meals.get('m1')).toMatchObject({ status: 'approved', assetIds: ['food-1'] });
    expect(result.mealsCreated).toBe(1);
  });

  it("passes the run's abort signal down to the database lookups", async () => {
    library = [asset('food-1', at(27, 12, 30))];
    const controller = new AbortController();
    await processPhotos({ reason: 'manual', window: WINDOW, signal: controller.signal });
    // The run links the caller's signal to its own controller, so aborting the caller reaches it.
    const passed = jest.mocked(reconcileEstimate).mock.calls[0][1].signal!;
    expect(passed.aborted).toBe(false);
    controller.abort();
    expect(passed.aborted).toBe(true);
  });
});
