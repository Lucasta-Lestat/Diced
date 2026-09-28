/** Weight entries (table `weight_entries`). OWNER: data-layer builder. */
import type { EntryStatus, LocalDate, PersonLabel, WeightEntry } from '../types';

export async function upsertWeightEntry(entry: WeightEntry): Promise<void> {
  throw new Error('not implemented');
}

export async function getWeightEntry(id: string): Promise<WeightEntry | null> {
  throw new Error('not implemented');
}

export interface WeightFilter {
  person?: PersonLabel;
  statuses?: EntryStatus[];
  from?: LocalDate;
  to?: LocalDate;
}

/** Newest date first. */
export async function listWeightEntries(filter?: WeightFilter): Promise<WeightEntry[]> {
  throw new Error('not implemented');
}

/**
 * Accepted weights (status approved | synced) for `person` in the `days` days before
 * `beforeDate` (exclusive), newest first — used for trend plausibility checks.
 */
export async function recentAcceptedWeights(
  person: PersonLabel,
  beforeDate: LocalDate,
  days: number,
): Promise<WeightEntry[]> {
  throw new Error('not implemented');
}

export async function setWeightStatus(
  id: string,
  status: EntryStatus,
  syncError?: string | null,
): Promise<void> {
  throw new Error('not implemented');
}

export async function deleteWeightEntry(id: string): Promise<void> {
  throw new Error('not implemented');
}
