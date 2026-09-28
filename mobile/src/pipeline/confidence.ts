/**
 * Pure rules shared by pipeline/review.ts (approve, "approve all confident") and the Review
 * screen's button count (ui/reviewModel.ts), so the number shown is the number approved.
 * No native imports beyond what pipeline/weights.ts needs.
 */
import type { MealEntry, WeightEntry } from '../types';
import { isPlausibleLb } from './weights';

/** Assumption prefix the review UI (and approve-all) treat as a flag. Written by nutrition/reconcile.ts. */
export const CHECK_PORTION_PREFIX = 'check_portion:';

/** Same bounds the Apps Script enforces (upsertMeals / upsertLibrary), so an approved meal can't fail a sync batch. */
export const MAX_MEAL_KCAL = 10_000;
export const MAX_MACRO_G = 2_000;

/** A weigh-in safe to approve without a look (high confidence, no flags, plausible value). */
export function isConfidentWeight(entry: WeightEntry): boolean {
  return entry.status === 'needs_review' && entry.confidence === 'high' && entry.flags.length === 0 && isPlausibleLb(entry.valueLb);
}

/** A meal safe to approve without a look (high confidence, no flags, every question answered). */
export function isConfidentMeal(meal: MealEntry): boolean {
  const estimate = meal.estimate;
  if (meal.status !== 'needs_review' || meal.error || !estimate || estimate.confidence !== 'high') return false;
  if (estimate.assumptions.some((a) => a.startsWith(CHECK_PORTION_PREFIX))) return false;
  if (!estimate.questions.every((q) => meal.answers[q.id]?.trim())) return false;
  const f = meal.final;
  return (
    [f.kcal, f.proteinG, f.carbsG, f.fatG].every((v) => Number.isFinite(v) && v >= 0) &&
    f.kcal <= MAX_MEAL_KCAL &&
    Math.max(f.proteinG, f.carbsG, f.fatG) <= MAX_MACRO_G
  );
}
