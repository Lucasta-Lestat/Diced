/** Pure mapping between app entries and sheet rows. OWNER: data-layer builder. */
import type { LibraryItem, MealEntry, MealSlot, WeightEntry } from '../types';
import type { SheetLibraryItem, SheetMealRow, SheetWeightRow } from './contract';

/** Throws if the entry has no value. */
export function weightEntryToRow(entry: WeightEntry): SheetWeightRow {
  throw new Error('not implemented');
}

/** `items` column text: `name grams g (kcal kcal) · …`; notes = user notes + assumptions + answers. */
export function mealEntryToRow(meal: MealEntry): SheetMealRow {
  throw new Error('not implemented');
}

export function slotToSheetMeal(slot: MealSlot): SheetMealRow['meal'] {
  throw new Error('not implemented');
}

export function libraryItemToRow(item: LibraryItem): SheetLibraryItem {
  throw new Error('not implemented');
}

export function libraryItemFromRow(row: SheetLibraryItem): LibraryItem {
  throw new Error('not implemented');
}
