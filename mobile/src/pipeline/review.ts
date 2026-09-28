/**
 * Review actions used by the UI. OWNER: nutrition/pipeline builder.
 */
import type { Macros, MealEntry, MealSlot, WeightEntry } from '../types';

export async function approveWeight(id: string, valueLb?: number, notes?: string): Promise<WeightEntry> {
  throw new Error('not implemented');
}

/** Choose a different candidate reading for the day. */
export async function chooseWeightCandidate(id: string, assetId: string): Promise<WeightEntry> {
  throw new Error('not implemented');
}

export async function rejectWeight(id: string): Promise<void> {
  throw new Error('not implemented');
}

export async function addManualWeight(localDate: string, valueLb: number, notes: string): Promise<WeightEntry> {
  throw new Error('not implemented');
}

export interface MealEdit {
  title?: string;
  slot?: MealSlot;
  time?: string;
  final?: Macros;
  notes?: string;
  answers?: Record<string, string>;
  /** Replace item grams (by index); totals are recomputed from items when given. */
  itemGrams?: Record<number, number>;
}

export async function editMeal(id: string, edit: MealEdit): Promise<MealEntry> {
  throw new Error('not implemented');
}

/** Re-run estimation with current notes + answers (+ reconcile). Keeps status needs_review. */
export async function reestimateMeal(id: string): Promise<MealEntry> {
  throw new Error('not implemented');
}

export async function approveMeal(id: string): Promise<MealEntry> {
  throw new Error('not implemented');
}

/** Reject (not food / not mine). If it was synced, queue a sheet delete. */
export async function rejectMeal(id: string): Promise<void> {
  throw new Error('not implemented');
}

/** Merge meal `b` into `a` (photos combined, re-estimated). */
export async function mergeMeals(aId: string, bId: string): Promise<MealEntry> {
  throw new Error('not implemented');
}

/** Save the meal's final numbers as a Food Library item (shared via the sheet). */
export async function saveMealToLibrary(id: string, name: string, serving: string): Promise<void> {
  throw new Error('not implemented');
}

/** Approve every needs_review entry whose confidence is high and has no flags/questions. */
export async function approveAllConfident(): Promise<{ weights: number; meals: number }> {
  throw new Error('not implemented');
}

export async function addManualMeal(localDate: string, time: string, slot: MealSlot, title: string, final: Macros, notes: string): Promise<MealEntry> {
  throw new Error('not implemented');
}
