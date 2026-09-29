/**
 * The processing pipeline. OWNER: nutrition/pipeline builder.
 * scan → exclude (heuristics) → classify thumbnails → read scales → group & estimate meals
 * → reconcile → store entries as needs_review → notify. Resumable: every step persists
 * per-photo state, so a run cut short by the time budget continues next time.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { classifyBatch, type ClassifyInput } from '../ai/classify';
import { AiApiError, AiNotConfiguredError } from '../ai/client';
import { readScale, toPounds, type ScaleReading } from '../ai/scale';
import { getSettings, updateSettings } from '../config/settings';
import { chunk } from '../db/database';
import { listLibrary } from '../db/library';
import { getMeal, listMeals, upsertMeal } from '../db/meals';
import {
  getPhotos,
  insertNewPhotos,
  listPickedPhotos,
  listUnclassified,
  listUnprocessed,
  markProcessed,
  setClassification,
  setPhotoError,
} from '../db/photos';
import { recordRun } from '../db/runs';
import { listWeightEntries, recentAcceptedWeights, upsertWeightEntry } from '../db/weights';
import { formatDayLabel, toLocalDate, toLocalTime } from '../lib/dates';
import { newId, weightEntryId } from '../lib/ids';
import { errorMessage, logger } from '../lib/log';
import { groupMealPhotos, guessMealSlot } from '../nutrition/grouping';
import { CAPTURE_DIR, isLibraryAssetId, PICKED_DIR, SAME_PHOTO_TOLERANCE_MS, withoutPickedDuplicates } from '../photos/appFiles';
import { makeThumbnail, prepareScaleImage } from '../photos/images';
import { listPhotosInRange, resolveReadableUri } from '../photos/scanner';
import { nextScanWindow, shiftLocalDays } from '../scheduling/due';
import { notifyReviewReady } from '../scheduling/notifications';
import type {
  AppSettings,
  EntryStatus,
  LibraryItem,
  MealEntry,
  PersonLabel,
  PhotoAsset,
  PhotoCategory,
  PhotoRecord,
  ProcessProgress,
  ProcessResult,
  RunReason,
  WeightCandidate,
  WeightEntry,
  WeightUnit,
} from '../types';
import { createLock, mapLimit, withWeightLock } from './concurrency';
import { estimateAndReconcile, isEmptyEstimate, loadMealImages, newMealEntry } from './mealEstimate';
import { answeredQuestions, withNewEstimate } from './mealRevision';
import {
  hasPresetCategory,
  modelConfidence,
  nextLastScanEnd,
  photoRecordFromAsset,
  PRESET_CATEGORY_CONFIDENCE,
  presetPhotoRecord,
  RETRY_LOOKBACK_DAYS,
} from './records';
import { attachCandidates, buildWeightEntries, CAPTURE_ASSET_PREFIX } from './weights';

export interface ProcessOptions {
  reason: RunReason;
  /** Explicit window; default = scheduling/due.nextScanWindow(settings, now). */
  window?: { startMs: number; endMs: number };
  /** Stop starting new work after this many ms (background: ~25 s iOS, ~8 min Android). */
  timeBudgetMs?: number;
  onProgress?: (p: ProcessProgress) => void;
  /** Abort signal from the UI. */
  signal?: AbortSignal;
}

export const CLASSIFY_BATCH_SIZE = 16;
export const CLASSIFY_CONCURRENCY = 2;
/** Scale readings / meal estimates in flight at once. */
export const AI_CONCURRENCY = 3;
const THUMBNAIL_CONCURRENCY = 4;
const MAX_RUN_ERRORS = 25;
/** History used for the weigh-in trend check and to disambiguate scale digits. */
const RECENT_WEIGHT_DAYS = 30;
/**
 * A photo showing only leftovers joins an earlier meal (still in review) taken up to this long
 * before it: people often photograph the plate again well after the 20-minute grouping gap.
 */
export const LEFTOVERS_ATTACH_MINUTES = 90;
const PHOTO_GONE = 'Photo no longer available';
const AUTOMATIC_REASONS: readonly RunReason[] = ['weekly', 'daily', 'background'];
const LIVE_MEAL_STATUSES: EntryStatus[] = ['needs_review', 'approved', 'synced', 'sync_error'];
/** After these, every further Claude call would fail the same way, so the run stops starting new ones. */
const RUN_STOPPING_KINDS = new Set(['auth', 'permission', 'not_found', 'rate_limit', 'overloaded', 'network', 'aborted']);

const log = logger('pipeline');

// ---------------------------------------------------------------------------
// Module state: single-flight run + photos claimed by whichever job is working on them
// ---------------------------------------------------------------------------

let inFlight: Promise<ProcessResult> | null = null;
let sideJobs = 0;
/**
 * Quick-log captures and hand-picked photos run alongside a scheduled run; claiming makes sure
 * no photo is read or estimated twice (which would create a duplicate meal).
 */
const claimed = new Set<string>();
/** Adding photos to a meal in review is a read-estimate-write of that meal; one at a time. */
const withMealAttachLock = createLock();

function claim<T extends { assetId: string }>(items: T[]): T[] {
  const mine = items.filter((p) => !claimed.has(p.assetId));
  for (const p of mine) claimed.add(p.assetId);
  return mine;
}

function release(items: { assetId: string }[]): void {
  for (const p of items) claimed.delete(p.assetId);
}

async function sideJob<T>(task: () => Promise<T>): Promise<T> {
  sideJobs++;
  try {
    return await task();
  } finally {
    sideJobs--;
  }
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

class RunContext {
  readonly result: ProcessResult;
  /** A run-stopping AI error happened (no key, rate limit, offline…). */
  halted = false;
  /**
   * Automatic runs leave a meal whose last photo is younger than the grouping gap for the next
   * run: more photos of it (the "after" photo) may still come, and estimating now splits it.
   */
  readonly holdRecentMeals: boolean;
  /**
   * Capture times of photos whose classification failed in this run for the first time: they may
   * be more photos of a nearby meal, so that meal waits for the next run (once).
   */
  readonly unsortedTimes: number[] = [];

  constructor(
    readonly settings: AppSettings,
    readonly person: PersonLabel,
    reason: RunReason,
    window: { startMs: number; endMs: number },
    private readonly deadline: number,
    readonly signal?: AbortSignal,
    private readonly onProgress?: (p: ProcessProgress) => void,
  ) {
    this.holdRecentMeals = AUTOMATIC_REASONS.includes(reason);
    this.result = {
      reason,
      windowStart: window.startMs,
      windowEnd: window.endMs,
      photosScanned: 0,
      photosExcluded: 0,
      photosClassified: 0,
      scalePhotos: 0,
      foodPhotos: 0,
      weightEntriesCreated: 0,
      mealsCreated: 0,
      errors: [],
      partial: false,
    };
  }

  shouldStop(): boolean {
    return this.halted || this.signal?.aborted === true || Date.now() >= this.deadline;
  }

  /** True (and the result marked partial) when no new work may start. */
  stopHere(): boolean {
    if (!this.shouldStop()) return false;
    this.result.partial = true;
    return true;
  }

  progress(stage: ProcessProgress['stage'], done: number, total: number, message: string): void {
    try {
      this.onProgress?.({ stage, done, total, message });
    } catch (e) {
      log.warn(`progress listener threw: ${errorMessage(e)}`);
    }
  }

  addError(message: string): void {
    const { errors } = this.result;
    if (errors.length < MAX_RUN_ERRORS && !errors.includes(message)) errors.push(message);
  }

  aiFailed(e: unknown): void {
    if (!isRunStopping(e)) return;
    this.halted = true;
    this.result.partial = true;
  }
}

function isCancelled(e: unknown): boolean {
  return e instanceof AiApiError && e.kind === 'aborted';
}

function isRunStopping(e: unknown): boolean {
  if (e instanceof AiNotConfiguredError) return true;
  return e instanceof AiApiError && RUN_STOPPING_KINDS.has(e.kind);
}

function requirePerson(settings: AppSettings): PersonLabel {
  if (!settings.person) {
    throw new Error('Choose who this phone logs for (Her or Him) in Settings before processing photos.');
  }
  return settings.person;
}

function describePhoto(record: { creationTime: number }): string {
  return `Photo from ${formatDayLabel(toLocalDate(record.creationTime))} ${toLocalTime(record.creationTime)}`;
}

async function setPhotoErrorQuietly(assetId: string, message: string): Promise<void> {
  try {
    await setPhotoError(assetId, message);
  } catch (e) {
    log.warn(`could not store photo error: ${errorMessage(e)}`);
  }
}

async function photoFailed(ctx: RunContext, record: PhotoRecord, e: unknown): Promise<void> {
  // Cancelled by the run itself (abort signal): not the photo's fault, just unfinished.
  if (isCancelled(e)) return ctx.aiFailed(e);
  const message = errorMessage(e);
  await setPhotoErrorQuietly(record.assetId, message);
  ctx.addError(`${describePhoto(record)}: ${message}`);
  ctx.aiFailed(e);
}

/** Includes up to 35 days before the window so failed / unfinished photos are retried. */
function retryRange(window: { startMs: number; endMs: number }): { startMs: number; endMs: number } {
  return { startMs: Math.min(window.startMs, shiftLocalDays(window.endMs, -RETRY_LOOKBACK_DAYS)), endMs: window.endMs };
}

// ---------------------------------------------------------------------------
// Stage 1: scan
// ---------------------------------------------------------------------------

/**
 * Drops library photos the user already hand-picked when the picker couldn't name their library
 * id (stored as `picked:<file name>`, see ui/photoPicker.ts), so they aren't logged a second time.
 */
async function withoutPickedCopies(assets: PhotoAsset[]): Promise<PhotoAsset[]> {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const a of assets) {
    if (!a.filename) continue;
    min = Math.min(min, a.creationTime);
    max = Math.max(max, a.creationTime);
  }
  if (min > max) return assets;
  const picked = await listPickedPhotos(min - SAME_PHOTO_TOLERANCE_MS, max + SAME_PHOTO_TOLERANCE_MS);
  return picked.length ? withoutPickedDuplicates(assets, picked) : assets;
}

async function scanStage(ctx: RunContext, window: { startMs: number; endMs: number }): Promise<void> {
  ctx.progress('scanning', 0, 0, 'Looking for new photos…');
  try {
    const assets = await withoutPickedCopies(await listPhotosInRange(window.startMs, window.endMs));
    const now = Date.now();
    const records = assets.map((a) => photoRecordFromAsset(a, now));
    await insertNewPhotos(records);
    ctx.result.photosScanned = records.length;
    ctx.result.photosExcluded = records.filter((r) => r.excludedReason !== null).length;
    ctx.progress('scanning', records.length, records.length, `Found ${records.length} photos`);
  } catch (e) {
    // Photos already known are still processed; the window is rescanned next time.
    ctx.addError(`Couldn't read the photo library: ${errorMessage(e)}`);
    ctx.result.partial = true;
  }
}

// ---------------------------------------------------------------------------
// Stage 2: classify thumbnails
// ---------------------------------------------------------------------------

async function thumbnailFailed(ctx: RunContext, record: PhotoRecord, e: unknown): Promise<void> {
  let exists = true;
  try {
    exists = (await resolveReadableUri(record.assetId, record.uri)) !== null;
  } catch {
    // Unknown: keep it for a retry.
  }
  if (!exists) {
    // Deleted since the scan: classify as "other" so it is not retried every run.
    await setClassification(record.assetId, 'other', 0);
    await setPhotoErrorQuietly(record.assetId, PHOTO_GONE);
    return;
  }
  if (!isCancelled(e)) unsorted(ctx, record);
  await photoFailed(ctx, record, e);
}

/**
 * A photo left unclassified by a failure. Only its first failure holds nearby meals back; a photo
 * that keeps failing (e.g. an image Claude can't read) must not block its meal forever.
 */
function unsorted(ctx: RunContext, record: PhotoRecord): void {
  if (record.error === null) ctx.unsortedTimes.push(record.creationTime);
}

async function classifyOneBatch(ctx: RunContext, batch: PhotoRecord[]): Promise<void> {
  const thumbs: (ClassifyInput | null)[] = batch.map(() => null);
  await mapLimit(batch, THUMBNAIL_CONCURRENCY, async (record, i) => {
    try {
      thumbs[i] = { assetId: record.assetId, image: await makeThumbnail(record.uri) };
    } catch (e) {
      await thumbnailFailed(ctx, record, e);
    }
  });
  const inputs = thumbs.filter((t): t is ClassifyInput => t !== null);
  if (inputs.length === 0) return;

  let output: Awaited<ReturnType<typeof classifyBatch>>;
  try {
    output = await classifyBatch(inputs, { signal: ctx.signal });
  } catch (e) {
    if (isCancelled(e)) return ctx.aiFailed(e);
    const message = errorMessage(e);
    const sent = new Set(inputs.map((i) => i.assetId));
    for (const record of batch) if (sent.has(record.assetId)) unsorted(ctx, record);
    for (const input of inputs) await setPhotoErrorQuietly(input.assetId, message);
    ctx.addError(`Couldn't sort ${inputs.length} photos: ${message}`);
    ctx.aiFailed(e);
    return;
  }
  for (const input of inputs) {
    const c = output[input.assetId] ?? { category: 'other' as PhotoCategory, confidence: 0 };
    await setClassification(input.assetId, c.category, modelConfidence(c.confidence));
    ctx.result.photosClassified++;
  }
}

/** Returns true when every unclassified photo got a classification attempt. */
async function classifyStage(ctx: RunContext, range: { startMs: number; endMs: number }): Promise<boolean> {
  const records = claim(await listUnclassified(range.startMs, range.endMs));
  try {
    const batches = chunk(records, CLASSIFY_BATCH_SIZE);
    let done = 0;
    ctx.progress('classifying', 0, records.length, `Sorting ${records.length} photos…`);
    const started = await mapLimit(
      batches,
      CLASSIFY_CONCURRENCY,
      async (batch) => {
        await classifyOneBatch(ctx, batch);
        done += batch.length;
        ctx.progress('classifying', done, records.length, `Sorted ${done} of ${records.length} photos`);
      },
      () => ctx.shouldStop(),
    );
    const complete = started === batches.length && !ctx.halted;
    if (!complete) ctx.result.partial = true;
    return complete;
  } finally {
    release(records);
  }
}

async function pendingPhotos(
  range: { startMs: number; endMs: number },
  categories: PhotoCategory[],
  cloud: boolean,
): Promise<PhotoRecord[]> {
  const records = await listUnprocessed(range.startMs, range.endMs, categories);
  // Manual mode never sends a photo the user didn't choose.
  return claim(cloud ? records : records.filter(hasPresetCategory));
}

// ---------------------------------------------------------------------------
// Stage 3: scale photos → weigh-ins
// ---------------------------------------------------------------------------

/** Pure: a model reading as a weigh-in candidate, or null when no weight was read. */
export function readingToCandidate(
  record: { assetId: string; creationTime: number },
  reading: ScaleReading,
  fallbackUnit: WeightUnit,
): WeightCandidate | null {
  if (!reading.isScale || reading.value === null || !Number.isFinite(reading.value) || reading.value <= 0) return null;
  const unit = reading.unit ?? fallbackUnit;
  return {
    assetId: record.assetId,
    takenAt: record.creationTime,
    valueLb: Math.round(toPounds(reading.value, unit) * 10) / 10,
    rawValue: reading.value,
    rawUnit: unit,
    readConfidence: reading.confidence,
  };
}

type ScaleOutcome = { kind: 'reading'; candidate: WeightCandidate } | { kind: 'unreadable' } | { kind: 'gone' };

async function readScalePhoto(
  settings: AppSettings,
  record: PhotoRecord,
  recentLb: number | null,
  signal?: AbortSignal,
): Promise<ScaleOutcome> {
  const uri = await resolveReadableUri(record.assetId, record.uri);
  if (!uri) return { kind: 'gone' };
  const image = await prepareScaleImage(uri);
  const reading = await readScale(image, { expectedUnit: settings.scaleUnit, recentLb }, { signal });
  const candidate = readingToCandidate(record, reading, settings.scaleUnit);
  return candidate ? { kind: 'reading', candidate } : { kind: 'unreadable' };
}

async function latestAcceptedLb(person: PersonLabel, beforeDate: string): Promise<number | null> {
  try {
    const recent = await recentAcceptedWeights(person, beforeDate, RECENT_WEIGHT_DAYS);
    return recent.find((e) => e.valueLb !== null)?.valueLb ?? null;
  } catch {
    return null;
  }
}

/**
 * Merges readings into the days' official entries under the weight lock. `changed` = entries
 * (re)written for review; `kept` = accepted days that only gained an extra candidate.
 */
async function saveWeightReadings(
  settings: AppSettings,
  person: PersonLabel,
  candidates: WeightCandidate[],
): Promise<{ changed: WeightEntry[]; kept: WeightEntry[] }> {
  return withWeightLock(async () => {
    const dates = candidates.map((c) => toLocalDate(c.takenAt)).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    const existing = await listWeightEntries({ person, from, to });
    const recent = await recentAcceptedWeights(person, from, RECENT_WEIGHT_DAYS);
    const entries = buildWeightEntries(person, candidates, existing, {
      morningCutoffHour: settings.morningCutoffHour,
      recent: recent.flatMap((e) => (e.valueLb === null ? [] : [{ localDate: e.localDate, valueLb: e.valueLb }])),
      now: Date.now(),
      expectedUnit: settings.scaleUnit,
    });
    const before = new Map(existing.map((e) => [e.id, e]));
    const changed: WeightEntry[] = [];
    const kept: WeightEntry[] = [];
    for (const entry of entries) {
      if (before.get(entry.id) === entry) {
        const withExtra = attachCandidates(entry, candidates);
        if (withExtra !== entry) await upsertWeightEntry(withExtra);
        kept.push(withExtra);
        continue;
      }
      await upsertWeightEntry(entry);
      changed.push(entry);
    }
    return { changed, kept };
  });
}

async function scaleStage(ctx: RunContext, records: PhotoRecord[]): Promise<void> {
  if (records.length === 0) return;
  ctx.result.scalePhotos += records.length;
  const earliest = records.map((r) => toLocalDate(r.creationTime)).sort()[0];
  const recentLb = await latestAcceptedLb(ctx.person, earliest);
  const candidates: WeightCandidate[] = [];
  const unreadable: PhotoRecord[] = [];
  const gone: string[] = [];
  let done = 0;
  ctx.progress('reading_scale', 0, records.length, `Reading ${records.length} scale photos…`);
  const started = await mapLimit(
    records,
    AI_CONCURRENCY,
    async (record) => {
      try {
        const outcome = await readScalePhoto(ctx.settings, record, recentLb, ctx.signal);
        if (outcome.kind === 'reading') candidates.push(outcome.candidate);
        else if (outcome.kind === 'gone') gone.push(record.assetId);
        else unreadable.push(record);
      } catch (e) {
        await photoFailed(ctx, record, e);
      }
      done++;
      ctx.progress('reading_scale', done, records.length, `Read ${done} of ${records.length} scale photos`);
    },
    () => ctx.shouldStop(),
  );
  if (started < records.length) ctx.result.partial = true;

  if (candidates.length > 0) {
    const { changed } = await saveWeightReadings(ctx.settings, ctx.person, candidates);
    ctx.result.weightEntriesCreated += changed.filter((e) => e.status === 'needs_review').length;
  }
  // Only after the entries are saved, so a crash in between re-reads the photos next time.
  await markProcessed([...candidates.map((c) => c.assetId), ...unreadable.map((r) => r.assetId), ...gone]);
  for (const id of gone) await setPhotoErrorQuietly(id, PHOTO_GONE);
  for (const record of unreadable) {
    // A photo the classifier guessed wrong is fine to drop silently; one the user picked is not.
    if (hasPresetCategory(record)) await setPhotoErrorQuietly(record.assetId, 'No readable scale display');
  }
}

// ---------------------------------------------------------------------------
// Stage 4: food photos → meals
// ---------------------------------------------------------------------------

async function loadLibrary(): Promise<LibraryItem[]> {
  try {
    return await listLibrary();
  } catch (e) {
    log.warn(`could not load the food library: ${errorMessage(e)}`);
    return [];
  }
}

function mealGapMs(settings: AppSettings): number {
  const minutes = settings.mealGroupingMinutes;
  return Math.max(0, Number.isFinite(minutes) ? minutes : 0) * 60_000;
}

function byTime(a: PhotoRecord, b: PhotoRecord): number {
  return a.creationTime - b.creationTime || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
}

/** Meals left for the next run so that one meal isn't split across two runs. */
function heldBack(ctx: RunContext, group: PhotoRecord[], gapMs: number, now: number): boolean {
  const first = group[0].creationTime;
  const last = group[group.length - 1].creationTime;
  const age = now - last;
  if (ctx.holdRecentMeals && age >= 0 && age < gapMs) return true;
  return ctx.unsortedTimes.some((t) => t > first - gapMs && t < last + gapMs);
}

/**
 * A meal still in review (this person's) that `group` belongs to: its photos are less than
 * `windowMs` from the group's ('either': on either side; 'before': the meal ended before the group
 * started). The closest one wins; null when none.
 */
async function findMealInReview(
  person: PersonLabel,
  group: PhotoRecord[],
  windowMs: number,
  side: 'either' | 'before',
): Promise<MealEntry | null> {
  const first = group[0].creationTime;
  const last = group[group.length - 1].creationTime;
  const groupIds = new Set(group.map((p) => p.assetId));
  const meals = await listMeals({
    person,
    statuses: ['needs_review'],
    from: toLocalDate(first - windowMs),
    to: toLocalDate(last + windowMs),
  });
  let best: MealEntry | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const meal of meals) {
    if (meal.assetIds.length === 0 || meal.assetIds.some((id) => groupIds.has(id))) continue;
    const times = (await getPhotos(meal.assetIds)).map((p) => p.creationTime);
    if (times.length === 0) continue;
    const mealFirst = Math.min(...times);
    const mealLast = Math.max(...times);
    const gap =
      side === 'before' ? (mealLast <= first ? first - mealLast : Number.POSITIVE_INFINITY) : Math.max(mealFirst - last, first - mealLast);
    if (gap < windowMs && gap < bestGap) {
      best = meal;
      bestGap = gap;
    }
  }
  return best;
}

/** Who / how a meal is estimated for (a run, or a quick-log capture). */
type MealJob = { person: PersonLabel; settings: AppSettings; signal?: AbortSignal };

/**
 * Adds `group` to a meal still in review that it belongs to, re-estimating the meal with all its
 * photos (so an "after" photo subtracts leftovers instead of becoming a second meal). Returns the
 * updated meal, or null when there is no such meal, or it left review / was edited while Claude
 * was working (the group is then handled on its own).
 */
async function addToMealInReview(
  job: MealJob,
  group: PhotoRecord[],
  library: LibraryItem[],
  windowMs: number,
  side: 'either' | 'before',
): Promise<MealEntry | null> {
  if (group.length === 0 || !(windowMs > 0)) return null;
  const target = await findMealInReview(job.person, group, windowMs, side);
  if (!target) return null;
  return withMealAttachLock(async () => {
    const meal = await getMeal(target.id);
    if (!meal || meal.status !== 'needs_review') return null;
    const known = new Set(meal.assetIds);
    const photos = [...(await getPhotos(meal.assetIds)), ...group.filter((p) => !known.has(p.assetId))].sort(byTime);
    const { images } = await loadMealImages(photos);
    if (images.length === 0) return null;
    const estimate = await estimateAndReconcile({
      images,
      slot: meal.slot,
      notes: meal.notes,
      answers: answeredQuestions(meal),
      library,
      hint: `${meal.title} ${meal.notes}`,
      settings: job.settings,
      signal: job.signal,
    });
    if (isEmptyEstimate(estimate)) return null;
    const latest = await getMeal(meal.id);
    if (!latest || latest.updatedAt !== meal.updatedAt) return null;
    // New photos taken before the meal's first one move its start (a retried earlier photo).
    const first = photos[0];
    const start = known.has(first.assetId)
      ? {}
      : { localDate: toLocalDate(first.creationTime), time: toLocalTime(first.creationTime) };
    const updated = withNewEstimate({ ...meal, ...start, assetIds: photos.map((p) => p.assetId) }, estimate, Date.now());
    await upsertMeal(updated);
    return updated;
  });
}

async function estimateGroup(
  ctx: RunContext,
  group: PhotoRecord[],
  library: LibraryItem[],
  earlierGroupsDone: () => Promise<unknown>,
): Promise<void> {
  const ids = group.map((p) => p.assetId);
  try {
    // More photos of a meal an earlier run already put in review (e.g. its "after" photo).
    if (await addToMealInReview(ctx, group, library, mealGapMs(ctx.settings), 'either')) {
      await markProcessed(ids);
      return;
    }
    const { images, missing } = await loadMealImages(group);
    if (images.length === 0) {
      await markProcessed(ids);
      for (const id of ids) await setPhotoErrorQuietly(id, PHOTO_GONE);
      return;
    }
    const estimate = await estimateAndReconcile({
      images,
      slot: guessMealSlot(group[0].creationTime),
      notes: '',
      answers: [],
      library,
      hint: '',
      settings: ctx.settings,
      signal: ctx.signal,
    });
    const present = group.filter((p) => !missing.includes(p.assetId));
    if (estimate.leftoversOnly) {
      // Only leftovers: the "after" photo of an earlier meal, once that meal (possibly estimated
      // in this same run) is saved. Its leftovers are then subtracted rather than logged as eaten.
      await earlierGroupsDone();
      if (await addToMealInReview(ctx, present, library, LEFTOVERS_ATTACH_MINUTES * 60_000, 'before')) {
        await markProcessed(ids);
        return;
      }
    }
    if (!isEmptyEstimate(estimate)) {
      await upsertMeal(newMealEntry(ctx.person, present, estimate, Date.now()));
      ctx.result.mealsCreated++;
    }
    await markProcessed(ids);
  } catch (e) {
    if (isCancelled(e)) return ctx.aiFailed(e);
    const message = errorMessage(e);
    for (const id of ids) await setPhotoErrorQuietly(id, message);
    ctx.addError(`Meal (${describePhoto(group[0])}): ${message}`);
    ctx.aiFailed(e);
  }
}

async function foodStage(ctx: RunContext, records: PhotoRecord[]): Promise<void> {
  if (records.length === 0) return;
  const gapMs = mealGapMs(ctx.settings);
  const now = Date.now();
  // Held-back photos stay unprocessed; the next run's retry range picks them up.
  const groups = groupMealPhotos(records, ctx.settings.mealGroupingMinutes).filter((g) => !heldBack(ctx, g, gapMs, now));
  if (groups.length === 0) return;
  ctx.result.foodPhotos += groups.reduce((n, g) => n + g.length, 0);
  const library = await loadLibrary();
  let done = 0;
  /** Settles when group i is finished (estimateGroup never rejects). */
  const finished: Promise<void>[] = [];
  ctx.progress('estimating_meals', 0, groups.length, `Estimating ${groups.length} meals…`);
  const started = await mapLimit(
    groups,
    AI_CONCURRENCY,
    async (group, index) => {
      // Groups start in order, so every earlier group's promise exists by now.
      const earlier = finished.slice(0, index);
      const task = estimateGroup(ctx, group, library, () => Promise.all(earlier));
      finished[index] = task;
      await task;
      done++;
      ctx.progress('estimating_meals', done, groups.length, `Estimated ${done} of ${groups.length} meals`);
    },
    () => ctx.shouldStop(),
  );
  if (started < groups.length) ctx.result.partial = true;
}

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

function summary(result: ProcessResult): string {
  const parts = [
    `${result.weightEntriesCreated} weigh-in${result.weightEntriesCreated === 1 ? '' : 's'}`,
    `${result.mealsCreated} meal${result.mealsCreated === 1 ? '' : 's'}`,
  ];
  return `${parts.join(' and ')} ready to review${result.partial ? ' (more next run)' : ''}`;
}

async function finishRun(
  ctx: RunContext,
  startedAt: number,
  window: { startMs: number; endMs: number },
  explicitWindow: boolean,
): Promise<void> {
  const { result } = ctx;
  ctx.progress('saving', 0, 1, 'Saving…');
  if (!result.partial) {
    const next = nextLastScanEnd(ctx.settings.lastScanEnd, window, explicitWindow);
    if (next !== null) {
      try {
        await updateSettings({ lastScanEnd: next });
      } catch (e) {
        ctx.addError(`Couldn't save scan progress: ${errorMessage(e)}`);
      }
    }
  }
  try {
    await recordRun(startedAt, result);
  } catch (e) {
    log.warn(`could not record the run: ${errorMessage(e)}`);
  }
  const created = result.weightEntriesCreated + result.mealsCreated;
  if (created > 0 && AUTOMATIC_REASONS.includes(result.reason)) {
    try {
      await notifyReviewReady(result.weightEntriesCreated, result.mealsCreated);
    } catch (e) {
      log.warn(`could not post review notification: ${errorMessage(e)}`);
    }
  }
  ctx.progress('done', 1, 1, summary(result));
}

async function runPipeline(opts: ProcessOptions): Promise<ProcessResult> {
  const startedAt = Date.now();
  const settings = await getSettings();
  const person = requirePerson(settings);
  const window = opts.window ?? nextScanWindow(settings, startedAt);
  const deadline = opts.timeBudgetMs !== undefined ? startedAt + Math.max(0, opts.timeBudgetMs) : Number.POSITIVE_INFINITY;
  const ctx = new RunContext(settings, person, opts.reason, window, deadline, opts.signal, opts.onProgress);
  const cloud = settings.classificationMode === 'cloud_thumbnails';
  const range = retryRange(window);

  try {
    let classificationComplete = true;
    if (cloud && !ctx.stopHere()) {
      await scanStage(ctx, window);
      classificationComplete = !ctx.stopHere() && (await classifyStage(ctx, range));
    }
    if (!ctx.stopHere()) {
      const scale = await pendingPhotos(range, ['scale'], cloud);
      try {
        await scaleStage(ctx, scale);
      } finally {
        release(scale);
      }
    }
    // Meals wait for classification to finish: a meal's later photos may still be unsorted,
    // and estimating now would split one meal into two.
    if (classificationComplete && !ctx.stopHere()) {
      const food = await pendingPhotos(range, ['food', 'nutrition_label'], cloud);
      try {
        await foodStage(ctx, food);
      } finally {
        release(food);
      }
    }
  } catch (e) {
    ctx.addError(errorMessage(e));
    ctx.result.partial = true;
  }
  await finishRun(ctx, startedAt, window, opts.window !== undefined);
  return ctx.result;
}

/** Single-flight: a second call while running returns the in-progress promise. */
export async function processPhotos(opts: ProcessOptions): Promise<ProcessResult> {
  if (!inFlight) {
    inFlight = runPipeline(opts).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** True while a run is in progress (including quick-log / picked-photo processing). */
export function isProcessing(): boolean {
  return inFlight !== null || sideJobs > 0;
}

// ---------------------------------------------------------------------------
// Quick log and hand-picked photos
// ---------------------------------------------------------------------------

/**
 * Copies a camera / picker file (in the cache, which the OS may purge) into the app's documents
 * folder `dir`. The absolute URI is stored; scanner.currentAppFileUri finds it again after iOS
 * moves the app container.
 */
async function keepAppCopy(uri: string, dir: string, id: string): Promise<string> {
  try {
    const folder = new Directory(Paths.document, dir);
    folder.create({ intermediates: true, idempotent: true });
    const source = new File(uri);
    const dest = new File(folder, `${id}${source.extension || '.jpg'}`);
    await source.copy(dest);
    return dest.uri;
  } catch (e) {
    // Still process it now; only keeping the image for later review is at risk.
    log.warn(`could not keep a copy of the photo: ${errorMessage(e)}`);
    return uri;
  }
}

async function markProcessedQuietly(assetIds: string[]): Promise<void> {
  try {
    await markProcessed(assetIds);
  } catch (e) {
    log.warn(`could not mark photos processed: ${errorMessage(e)}`);
  }
}

/** A failed meal capture's message, telling the user what to do (unless it already does). */
function retakeMessage(e: unknown): string {
  const message = errorMessage(e).trim();
  if (/retake|take the photo again|type the meal in/i.test(message)) return message;
  return `${message}${/[.!?]$/.test(message) ? '' : '.'} Nothing was logged — take the photo again or type the meal in.`;
}

async function captureScale(settings: AppSettings, person: PersonLabel, record: PhotoRecord): Promise<string> {
  const recentLb = await latestAcceptedLb(person, record.localDate);
  const outcome = await readScalePhoto(settings, record, recentLb);
  if (outcome.kind !== 'reading') {
    await markProcessed([record.assetId]);
    const message =
      outcome.kind === 'gone' ? PHOTO_GONE : "Couldn't read a weight from that photo — retake it or type the number in.";
    await setPhotoErrorQuietly(record.assetId, message);
    throw new Error(message);
  }
  await saveWeightReadings(settings, person, [outcome.candidate]);
  await markProcessed([record.assetId]);
  return weightEntryId(person, toLocalDate(outcome.candidate.takenAt));
}

/** The meal the capture ended up in: a meal still in review it belongs to, or a new one. */
async function captureMeal(settings: AppSettings, person: PersonLabel, record: PhotoRecord): Promise<string> {
  const job: MealJob = { person, settings };
  const library = await loadLibrary();
  // Another shot of a meal still in review (a second angle, the "after" photo) joins that meal.
  const joined = await addToMealInReview(job, [record], library, mealGapMs(settings), 'either');
  if (joined) {
    await markProcessed([record.assetId]);
    return joined.id;
  }
  const { images } = await loadMealImages([record]);
  if (images.length === 0) throw new Error(PHOTO_GONE);
  const estimate = await estimateAndReconcile({
    images,
    slot: guessMealSlot(record.creationTime),
    notes: '',
    answers: [],
    library,
    hint: '',
    settings,
  });
  if (estimate.leftoversOnly) {
    const after = await addToMealInReview(job, [record], library, LEFTOVERS_ATTACH_MINUTES * 60_000, 'before');
    if (after) {
      await markProcessed([record.assetId]);
      return after.id;
    }
  }
  if (isEmptyEstimate(estimate)) throw new Error("Couldn't find any food in that photo — retake it or type the meal in.");
  const meal = newMealEntry(person, [record], estimate, Date.now());
  await upsertMeal(meal);
  await markProcessed([record.assetId]);
  return meal.id;
}

/**
 * Quick-log: a photo just taken in the app with a known category. Stores it
 * (origin 'capture'), reads/estimates immediately, returns the entry id: the day's weigh-in, or
 * the meal — a new one, or the meal still in review this photo belongs to (e.g. its "after" photo).
 */
export async function processCapturedPhoto(
  uri: string,
  category: 'scale' | 'food',
  takenAt: number,
): Promise<{ kind: 'weight' | 'meal'; id: string }> {
  return sideJob(async () => {
    const settings = await getSettings();
    const person = requirePerson(settings);
    const id = newId();
    const storedUri = await keepAppCopy(uri, CAPTURE_DIR, id);
    const record = presetPhotoRecord(
      { assetId: `${CAPTURE_ASSET_PREFIX}${id}`, uri: storedUri, creationTime: takenAt, origin: 'capture' },
      category,
      Date.now(),
    );
    // Recorded first, so the app being killed mid-way leaves it for the next run to retry. A scale
    // photo that fails is retried too (a retake just adds a reading to the same day).
    await insertNewPhotos([record]);
    claim([record]);
    try {
      if (category === 'scale') return { kind: 'weight' as const, id: await captureScale(settings, person, record) };
      return { kind: 'meal' as const, id: await captureMeal(settings, person, record) };
    } catch (e) {
      if (category === 'food') {
        // A failed meal capture is not retried by a later run: the user sees the error and takes
        // the photo again, and a retried first shot would then log the same food a second time.
        const message = retakeMessage(e);
        await markProcessedQuietly([record.assetId]);
        await setPhotoErrorQuietly(record.assetId, message);
        throw new Error(message);
      }
      await setPhotoErrorQuietly(record.assetId, errorMessage(e));
      throw e;
    } finally {
      release([record]);
    }
  });
}

/**
 * Photos the user picked, as records with their chosen category (existing rows are re-labelled).
 * The picker hands over a copy in the cache, which the OS may purge: a library photo can be read
 * from the library again later (scanner.resolveReadableUri), but a pick without a library id is
 * copied into the app's documents first, like a quick-log capture.
 */
async function registerPickedPhotos(
  assets: { assetId: string; uri: string; creationTime: number }[],
  category: 'scale' | 'food',
): Promise<PhotoRecord[]> {
  const now = Date.now();
  const known = new Map((await getPhotos(assets.map((a) => a.assetId))).map((p) => [p.assetId, p]));
  const fresh = await Promise.all(
    assets
      .filter((a) => !known.has(a.assetId))
      .map(async (a) => (isLibraryAssetId(a.assetId) ? a : { ...a, uri: await keepAppCopy(a.uri, PICKED_DIR, newId()) })),
  );
  const freshRecords = new Map(fresh.map((a) => [a.assetId, presetPhotoRecord({ ...a, origin: 'library' }, category, now)]));
  await insertNewPhotos([...freshRecords.values()]);
  const records: PhotoRecord[] = [];
  for (const asset of assets) {
    const existing = known.get(asset.assetId);
    if (existing) await setClassification(asset.assetId, category, PRESET_CATEGORY_CONFIDENCE);
    records.push(
      existing
        ? { ...existing, uri: asset.uri || existing.uri, category, categoryConfidence: PRESET_CATEGORY_CONFIDENCE }
        : (freshRecords.get(asset.assetId) as PhotoRecord),
    );
  }
  return records;
}

/** Food photos that already belong to a meal in the queue or the sheet (picking them again would double count). */
async function withoutLoggedMealPhotos(person: PersonLabel, records: PhotoRecord[]): Promise<PhotoRecord[]> {
  if (records.length === 0) return records;
  const dates = records.map((r) => toLocalDate(r.creationTime)).sort();
  const meals = await listMeals({ person, statuses: LIVE_MEAL_STATUSES, from: dates[0], to: dates[dates.length - 1] });
  const used = new Set(meals.flatMap((m) => m.assetIds));
  return records.filter((r) => !used.has(r.assetId));
}

/**
 * Hand-picked photos (manual mode or "add photos" in review): insert as library photos
 * with a preset category and process them now.
 */
export async function processPickedPhotos(
  assets: { assetId: string; uri: string; creationTime: number }[],
  category: 'scale' | 'food',
): Promise<ProcessResult> {
  return sideJob(async () => {
    const startedAt = Date.now();
    const settings = await getSettings();
    const person = requirePerson(settings);
    const unique = [...new Map(assets.map((a) => [a.assetId, a])).values()];
    const times = unique.map((a) => a.creationTime);
    const window = unique.length
      ? { startMs: Math.min(...times), endMs: Math.max(...times) + 1 }
      : { startMs: startedAt, endMs: startedAt };
    const ctx = new RunContext(settings, person, 'manual', window, Number.POSITIVE_INFINITY);
    ctx.result.photosScanned = unique.length;

    const mine = claim(unique);
    if (mine.length < unique.length) {
      ctx.addError(`${unique.length - mine.length} photo(s) are already being processed.`);
    }
    try {
      const records = await registerPickedPhotos(mine, category);
      if (category === 'scale') {
        await scaleStage(ctx, records);
      } else {
        const fresh = await withoutLoggedMealPhotos(person, records);
        if (fresh.length < records.length) {
          ctx.addError(`${records.length - fresh.length} photo(s) are already part of a logged meal.`);
        }
        await foodStage(ctx, fresh);
      }
    } catch (e) {
      ctx.addError(errorMessage(e));
    } finally {
      release(mine);
    }
    try {
      await recordRun(startedAt, ctx.result);
    } catch (e) {
      log.warn(`could not record the run: ${errorMessage(e)}`);
    }
    return ctx.result;
  });
}

/** Test-only: forget in-flight state. */
export function __resetProcessForTests(): void {
  inFlight = null;
  sideJobs = 0;
  claimed.clear();
}
