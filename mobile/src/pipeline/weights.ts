/**
 * Pure logic turning scale readings into one official WeightEntry per day. OWNER: nutrition/pipeline builder.
 */
import type { LocalDate, PersonLabel, WeightCandidate, WeightEntry } from '../types';

export interface BuildWeightOptions {
  morningCutoffHour: number;
  /** Accepted weights before the window (newest first), for the trend check. */
  recent: { localDate: LocalDate; valueLb: number }[];
  now: number;
}

/**
 * For each day: choose the earliest reading before the morning cutoff (else the earliest
 * of the day); flags: `multiple_readings` (spread > 0.6 lb), `not_morning`,
 * `low_read_confidence`, `differs_from_trend` (> 4 lb or > 2.5 % from the median of the
 * last 7 accepted days), `unit_converted`. Confidence = min(read confidence, trend check).
 * Existing entries that are approved/synced are never overwritten (returned unchanged);
 * needs_review entries get the new candidates merged in.
 */
export function buildWeightEntries(
  person: PersonLabel,
  candidates: WeightCandidate[],
  existing: WeightEntry[],
  opts: BuildWeightOptions,
): WeightEntry[] {
  throw new Error('not implemented');
}
