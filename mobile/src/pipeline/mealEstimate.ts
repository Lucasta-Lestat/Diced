/**
 * Meal estimation shared by the pipeline and the review screen (re-estimate / merge).
 * OWNER: nutrition/pipeline builder.
 */
import { estimateMeal } from '../ai/food';
import { toLocalDate, toLocalTime } from '../lib/dates';
import { newId } from '../lib/ids';
import { guessMealSlot, MAX_PHOTOS_PER_MEAL, pickMealPhotos } from '../nutrition/grouping';
import { libraryCandidates } from '../nutrition/library';
import { reconcileEstimate } from '../nutrition/reconcile';
import { prepareForModel, type PreparedImage } from '../photos/images';
import { resolveReadableUri } from '../photos/scanner';
import type { AppSettings, LibraryItem, MealEntry, MealEstimate, MealSlot, PersonLabel, PhotoRecord } from '../types';

export interface MealImage {
  image: PreparedImage;
  takenAt: number;
}

function byTime(a: PhotoRecord, b: PhotoRecord): number {
  return a.creationTime - b.creationTime || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
}

/**
 * Up to 4 photos of a meal prepared for the model (first, last and evenly spaced ones), in time
 * order. Photos that no longer exist are skipped and replaced by others from the meal.
 */
export async function loadMealImages(photos: PhotoRecord[]): Promise<{ images: MealImage[]; missing: string[] }> {
  const sorted = [...photos].sort(byTime);
  const preferred = pickMealPhotos(sorted);
  const order = [...preferred, ...sorted.filter((p) => !preferred.includes(p))];
  const loaded: { record: PhotoRecord; image: PreparedImage }[] = [];
  const missing: string[] = [];
  for (const record of order) {
    if (loaded.length >= MAX_PHOTOS_PER_MEAL) break;
    const uri = await resolveReadableUri(record.assetId, record.uri);
    if (!uri) {
      missing.push(record.assetId);
      continue;
    }
    loaded.push({ record, image: await prepareForModel(uri) });
  }
  loaded.sort((a, b) => byTime(a.record, b.record));
  return { images: loaded.map(({ record, image }) => ({ image, takenAt: record.creationTime })), missing };
}

export interface MealEstimateRequest {
  images: MealImage[];
  slot: MealSlot;
  notes: string;
  answers: { question: string; answer: string }[];
  /** The whole local Food Library; pre-filtered here with `hint`. */
  library: LibraryItem[];
  /** Words that point at a usual meal (notes, title). */
  hint: string;
  settings: Pick<AppSettings, 'plateDiameterIn' | 'accuracyMode' | 'webLookupForRestaurants'>;
  /** Cancels the model request (the run's abort signal). */
  signal?: AbortSignal;
}

/** Model estimate, then checked against USDA / Open Food Facts / published nutrition. */
export async function estimateAndReconcile(req: MealEstimateRequest): Promise<MealEstimate> {
  const estimate = await estimateMeal(
    {
      images: req.images,
      slot: req.slot,
      notes: req.notes,
      answers: req.answers,
      library: libraryCandidates(req.library, req.hint),
      plateDiameterIn: req.settings.plateDiameterIn,
      accuracyMode: req.settings.accuracyMode,
    },
    { signal: req.signal },
  );
  return reconcileEstimate(estimate, { useUsda: true, webLookupForRestaurants: req.settings.webLookupForRestaurants });
}

/** The model found nothing to eat in the photos (a misclassified photo). */
export function isEmptyEstimate(estimate: MealEstimate): boolean {
  return estimate.items.length === 0 && !(estimate.totals.kcal > 0);
}

/** A new needs_review meal for photos of one meal (time/slot from the first photo). */
export function newMealEntry(person: PersonLabel, photos: PhotoRecord[], estimate: MealEstimate, now: number): MealEntry {
  const sorted = [...photos].sort(byTime);
  const first = sorted[0];
  return {
    id: newId(),
    person,
    localDate: toLocalDate(first.creationTime),
    time: toLocalTime(first.creationTime),
    slot: guessMealSlot(first.creationTime),
    assetIds: sorted.map((p) => p.assetId),
    estimate,
    final: { ...estimate.totals },
    title: estimate.title,
    answers: {},
    notes: '',
    status: 'needs_review',
    error: null,
    updatedAt: now,
  };
}
