/** Meal entries (table `meals`). OWNER: data-layer builder. */
import type { EntryStatus, LocalDate, MealEntry, PersonLabel } from '../types';

export async function upsertMeal(meal: MealEntry): Promise<void> {
  throw new Error('not implemented');
}

export async function getMeal(id: string): Promise<MealEntry | null> {
  throw new Error('not implemented');
}

export interface MealFilter {
  person?: PersonLabel;
  statuses?: EntryStatus[];
  from?: LocalDate;
  to?: LocalDate;
}

/** Ordered by date desc, time asc. */
export async function listMeals(filter?: MealFilter): Promise<MealEntry[]> {
  throw new Error('not implemented');
}

export async function setMealStatus(id: string, status: EntryStatus, error?: string | null): Promise<void> {
  throw new Error('not implemented');
}

export async function deleteMeal(id: string): Promise<void> {
  throw new Error('not implemented');
}

/** Ids of meals deleted locally after they were synced (so sync can delete them in the sheet). */
export async function listPendingSheetDeletes(): Promise<string[]> {
  throw new Error('not implemented');
}
export async function addPendingSheetDelete(id: string): Promise<void> {
  throw new Error('not implemented');
}
export async function clearPendingSheetDeletes(ids: string[]): Promise<void> {
  throw new Error('not implemented');
}
