/** Pure view-model helpers for Home and Review (no native imports). */
import { addDays, mondayOf } from '../lib/dates';
import { isConfidentMeal, isConfidentWeight } from '../pipeline/confidence';
import type { ClarifyingQuestion, EntryStatus, LocalDate, MealEntry, WeightEntry } from '../types';

export interface ReviewDay {
  date: LocalDate;
  weights: WeightEntry[];
  meals: MealEntry[];
}

/** Days newest first; within a day meals run in time order (weights have one per day). */
export function groupByDay(weights: WeightEntry[], meals: MealEntry[]): ReviewDay[] {
  const days = new Map<LocalDate, ReviewDay>();
  const day = (date: LocalDate) => {
    let d = days.get(date);
    if (!d) {
      d = { date, weights: [], meals: [] };
      days.set(date, d);
    }
    return d;
  };
  for (const w of weights) day(w.localDate).weights.push(w);
  for (const m of meals) day(m.localDate).meals.push(m);
  for (const d of days.values()) {
    d.meals.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : 1));
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function unansweredQuestions(meal: MealEntry): ClarifyingQuestion[] {
  return (meal.estimate?.questions ?? []).filter((q) => !meal.answers[q.id]?.trim());
}

/** The exact rule pipeline/review.approveAllConfident applies, so the button's count matches what it approves. */
export { isConfidentMeal, isConfidentWeight };

export function countConfident(weights: WeightEntry[], meals: MealEntry[]): number {
  return weights.filter(isConfidentWeight).length + meals.filter(isConfidentMeal).length;
}

const COUNTED: EntryStatus[] = ['needs_review', 'approved', 'synced', 'sync_error'];

/** Everything not rejected counts toward the day's intake / the week's weigh-ins. */
export function isCounted(status: EntryStatus): boolean {
  return COUNTED.includes(status);
}

export function dayKcal(meals: MealEntry[], date: LocalDate): number {
  return meals
    .filter((m) => m.localDate === date && isCounted(m.status))
    .reduce((sum, m) => sum + (Number.isFinite(m.final.kcal) ? m.final.kcal : 0), 0);
}

export interface WeekDay {
  date: LocalDate;
  entry: WeightEntry | null;
}

/** Monday..Sunday of the week containing `today`, with that day's (non-rejected) weigh-in. */
export function weekWeighIns(weights: WeightEntry[], today: LocalDate): WeekDay[] {
  const monday = mondayOf(today);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    const entry = weights.find((w) => w.localDate === date && isCounted(w.status) && w.valueLb !== null) ?? null;
    return { date, entry };
  });
}

/** Mean of the week's daily values (the sheet's 7-day average uses the same rule). */
export function averageLb(days: WeekDay[]): number | null {
  const values = days.flatMap((d) => (d.entry?.valueLb != null ? [d.entry.valueLb] : []));
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/** Other meals the same day that `meal` can be merged into (earlier ones first). */
export function mergeCandidates(meal: MealEntry, sameDay: MealEntry[]): MealEntry[] {
  return sameDay
    .filter((m) => m.id !== meal.id && m.localDate === meal.localDate && m.status !== 'rejected')
    .sort((a, b) => {
      const aBefore = a.time <= meal.time ? 0 : 1;
      const bBefore = b.time <= meal.time ? 0 : 1;
      if (aBefore !== bBefore) return aBefore - bBefore;
      // Closest in time first within each side.
      return Math.abs(timeToMinutes(meal.time) - timeToMinutes(a.time)) - Math.abs(timeToMinutes(meal.time) - timeToMinutes(b.time));
    });
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Proportional kcal for an item whose grams were edited (preview before saving). */
export function scaledKcal(kcal: number, oldGrams: number | null, newGrams: number): number | null {
  if (oldGrams === null || !(oldGrams > 0) || !Number.isFinite(newGrams)) return null;
  return Math.round((kcal * newGrams) / oldGrams);
}
