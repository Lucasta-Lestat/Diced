/** Estimate a meal's nutrition from one or more photos. OWNER: AI builder. */
import type { LibraryItem, MealEstimate, MealSlot } from '../types';
import type { PreparedImage } from '../photos/images';
import { toLocalTime } from '../lib/dates';
import { logger } from '../lib/log';
import { mergeSamples } from './merge';
import { FOOD_SYSTEM, foodPhotoLabel, foodUserText } from './prompts';
import { type AiCallOptions, structuredCall, userContent } from './request';
import { FoodSchema, toMealEstimate } from './schemas';

export interface MealEstimateInput {
  images: { image: PreparedImage; takenAt: number }[];
  slot: MealSlot;
  /** User notes, e.g. "half portion, no dressing". */
  notes: string;
  /** Answers to earlier clarifying questions: question text → answer. */
  answers: { question: string; answer: string }[];
  /** Candidate "usual meals" the model may match (already pre-filtered, ≤ 30). */
  library: LibraryItem[];
  plateDiameterIn: number | null;
  /** 'thorough' → two independent samples, averaged, disagreement lowers confidence. */
  accuracyMode: 'standard' | 'thorough';
}

const log = logger('ai.food');

/** Independent requests in thorough mode. */
export const THOROUGH_SAMPLES = 2;

async function estimateOnce(input: MealEstimateInput, opts: AiCallOptions): Promise<MealEstimate> {
  const images = input.images.map(({ image, takenAt }, i) => ({
    image,
    label: input.images.length > 1 ? foodPhotoLabel(i, takenAt, toLocalTime) : undefined,
  }));
  const text = foodUserText({
    takenAt: input.images.map((i) => i.takenAt),
    slot: input.slot,
    notes: input.notes,
    answers: input.answers,
    library: input.library,
    plateDiameterIn: input.plateDiameterIn,
    formatTime: toLocalTime,
  });
  const { data, model } = await structuredCall(
    { task: 'estimate this meal', schema: FoodSchema, system: FOOD_SYSTEM, content: userContent(images, text), effort: 'high' },
    opts,
  );
  return toMealEstimate(data, { model, libraryIds: input.library.map((item) => item.id), now: Date.now() });
}

/**
 * Thorough mode: independent samples in parallel. If some fail, the rest are still used (the
 * result then reports fewer samples); if all fail, the first error is thrown.
 */
async function estimateThorough(input: MealEstimateInput, opts: AiCallOptions): Promise<MealEstimate> {
  const settled = await Promise.allSettled(Array.from({ length: THOROUGH_SAMPLES }, () => estimateOnce(input, opts)));
  const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  if (ok.length === 0) throw failed[0];
  if (failed.length) log.warn(`thorough mode: ${failed.length} of ${THOROUGH_SAMPLES} estimates failed`, failed[0]);
  return mergeSamples(ok);
}

/**
 * Itemised estimate (structured output, effort `high`):
 * - every item gets grams + macros + a USDA search phrase
 * - reads nutrition-facts labels exactly when visible (method 'label')
 * - reports barcode digits if legible (validated by the caller)
 * - treats multiple photos as one meal (angles / before-after → estimate what was eaten)
 * - asks ≤ 3 clarifying questions only when the answer would move the total by > 10 %
 * The result is NOT yet reconciled against databases (see nutrition/reconcile.ts).
 */
export async function estimateMeal(input: MealEstimateInput, opts: AiCallOptions = {}): Promise<MealEstimate> {
  if (input.images.length === 0) throw new Error('estimateMeal needs at least one photo');
  return input.accuracyMode === 'thorough' ? estimateThorough(input, opts) : estimateOnce(input, opts);
}
