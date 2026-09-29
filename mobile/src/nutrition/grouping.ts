/** Pure meal-grouping helpers. OWNER: nutrition/pipeline builder. */
import type { MealSlot, PhotoRecord } from '../types';

/** Most photos sent to the model for one meal. */
export const MAX_PHOTOS_PER_MEAL = 4;

function byTime(a: PhotoRecord, b: PhotoRecord): number {
  return a.creationTime - b.creationTime || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
}

/**
 * Group food / nutrition-label photos into meals: consecutive photos less than `gapMinutes`
 * apart form one group, even across midnight (a 23:50 dinner and its 00:05 "after" photo are
 * one meal, logged on the first photo's day). Input may be unsorted; output groups are sorted
 * by first photo time.
 */
export function groupMealPhotos(photos: PhotoRecord[], gapMinutes: number): PhotoRecord[][] {
  const gapMs = Math.max(0, Number.isFinite(gapMinutes) ? gapMinutes : 0) * 60_000;
  const groups: PhotoRecord[][] = [];
  let current: PhotoRecord[] = [];
  for (const photo of [...photos].sort(byTime)) {
    const prev = current[current.length - 1];
    if (prev && photo.creationTime - prev.creationTime < gapMs) {
      current.push(photo);
    } else {
      if (current.length > 0) groups.push(current);
      current = [photo];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** breakfast < 10:30 ≤ lunch < 15:00 ≤ snack < 17:00 ≤ dinner < 21:30 ≤ snack; before 04:00 → snack. */
export function guessMealSlot(takenAtMs: number): MealSlot {
  const d = new Date(takenAtMs);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes < 4 * 60) return 'snack';
  if (minutes < 10 * 60 + 30) return 'breakfast';
  if (minutes < 15 * 60) return 'lunch';
  if (minutes < 17 * 60) return 'snack';
  if (minutes < 21 * 60 + 30) return 'dinner';
  return 'snack';
}

/**
 * At most `max` photos of a meal for the model: the first and last (before / after) plus
 * evenly spaced ones in between. Keeps the input order.
 */
export function pickMealPhotos<T>(photos: T[], max: number = MAX_PHOTOS_PER_MEAL): T[] {
  const limit = Math.max(1, Math.floor(max));
  if (photos.length <= limit) return [...photos];
  if (limit === 1) return [photos[0]];
  const picked: T[] = [];
  for (let i = 0; i < limit; i++) picked.push(photos[Math.round((i * (photos.length - 1)) / (limit - 1))]);
  return picked;
}
