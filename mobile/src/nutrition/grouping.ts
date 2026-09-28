/** Pure meal-grouping helpers. OWNER: nutrition/pipeline builder. */
import type { MealSlot, PhotoRecord } from '../types';

/**
 * Group food / nutrition-label photos (same local day) into meals: consecutive photos
 * less than `gapMinutes` apart form one group. Input may be unsorted; output groups
 * are sorted by first photo time.
 */
export function groupMealPhotos(photos: PhotoRecord[], gapMinutes: number): PhotoRecord[][] {
  throw new Error('not implemented');
}

/** breakfast < 10:30 ≤ lunch < 15:00 ≤ snack < 17:00 ≤ dinner < 21:30 ≤ snack; before 04:00 → snack. */
export function guessMealSlot(takenAtMs: number): MealSlot {
  throw new Error('not implemented');
}
