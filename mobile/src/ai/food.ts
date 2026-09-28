/** Estimate a meal's nutrition from one or more photos. OWNER: AI builder. */
import type { LibraryItem, MealEstimate, MealSlot } from '../types';
import type { PreparedImage } from '../photos/images';

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

/**
 * Itemised estimate (structured output, effort `high`):
 * - every item gets grams + macros + a USDA search phrase
 * - reads nutrition-facts labels exactly when visible (method 'label')
 * - reports barcode digits if legible (validated by the caller)
 * - treats multiple photos as one meal (angles / before-after → estimate what was eaten)
 * - asks ≤ 3 clarifying questions only when the answer would move the total by > 10 %
 * The result is NOT yet reconciled against databases (see nutrition/reconcile.ts).
 */
export async function estimateMeal(input: MealEstimateInput): Promise<MealEstimate> {
  throw new Error('not implemented');
}
