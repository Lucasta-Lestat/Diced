/**
 * Pure logic turning scale readings into one official WeightEntry per day. OWNER: nutrition/pipeline builder.
 */
import { localHour, toLocalDate, toLocalTime } from '../lib/dates';
import { weightEntryId } from '../lib/ids';
import type {
  Confidence,
  EntryStatus,
  LocalDate,
  PersonLabel,
  WeightCandidate,
  WeightEntry,
  WeightUnit,
} from '../types';

export interface BuildWeightOptions {
  morningCutoffHour: number;
  /** Accepted weights before the window (newest first), for the trend check. */
  recent: { localDate: LocalDate; valueLb: number }[];
  now: number;
  /**
   * Unit the scale is set to (Settings). A reading in another unit gets `unit_converted`.
   * Default 'lb'. (Additive to the declared contract.)
   */
  expectedUnit?: WeightUnit;
}

/** Quick-log captures get synthetic asset ids `capture:<uuid>`. */
export const CAPTURE_ASSET_PREFIX = 'capture:';

/** Same bounds the Apps Script enforces; outside them a sync of the whole batch would fail. */
export const MIN_PLAUSIBLE_LB = 50;
export const MAX_PLAUSIBLE_LB = 700;
export const SPREAD_FLAG_LB = 0.6;
export const TREND_MAX_DIFF_LB = 4;
export const TREND_MAX_DIFF_FRACTION = 0.025;
export const TREND_HISTORY_DAYS = 7;
/** Readings this close to the first morning reading count as one weigh-in (a retake). */
export const RETAKE_WINDOW_MS = 10 * 60_000;

/** Entries the user already accepted; new readings never change them. */
export const PROTECTED_STATUSES: readonly EntryStatus[] = ['approved', 'synced', 'sync_error'];

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

const round1 = (n: number) => Math.round(n * 10) / 10;

export function isPlausibleLb(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PLAUSIBLE_LB && value <= MAX_PLAUSIBLE_LB;
}

function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

function byTakenAt(a: WeightCandidate, b: WeightCandidate): number {
  return a.takenAt - b.takenAt || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
}

function isMorning(c: WeightCandidate, cutoffHour: number): boolean {
  return localHour(c.takenAt) < cutoffHour;
}

export function sourceForAsset(assetId: string | null): WeightEntry['source'] {
  if (assetId === null) return 'manual';
  return assetId.startsWith(CAPTURE_ASSET_PREFIX) ? 'capture' : 'photo';
}

/**
 * The official reading: the earliest morning (before the cutoff) reading, else the earliest of
 * the day. A retake within 10 minutes of it with a clearer display (higher read confidence)
 * wins, since people re-snap a blurry scale. Implausible values are only chosen when there is
 * nothing else.
 */
export function chooseReading(candidates: WeightCandidate[], morningCutoffHour: number): WeightCandidate | null {
  const sorted = [...candidates].sort(byTakenAt);
  const plausible = sorted.filter((c) => isPlausibleLb(c.valueLb));
  const pool = plausible.length > 0 ? plausible : sorted;
  if (pool.length === 0) return null;
  const morning = pool.filter((c) => isMorning(c, morningCutoffHour));
  const first = (morning.length > 0 ? morning : pool)[0];
  const session = pool.filter((c) => c.takenAt >= first.takenAt && c.takenAt - first.takenAt <= RETAKE_WINDOW_MS);
  return session.reduce((best, c) =>
    CONFIDENCE_RANK[c.readConfidence] > CONFIDENCE_RANK[best.readConfidence] ? c : best,
  );
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median of the last 7 accepted days before `date`, or null without history. */
export function trendBaseline(history: { localDate: LocalDate; valueLb: number }[], date: LocalDate): number | null {
  const byDay = new Map<LocalDate, number>();
  for (const h of history) {
    if (h.localDate < date && isPlausibleLb(h.valueLb) && !byDay.has(h.localDate)) byDay.set(h.localDate, h.valueLb);
  }
  const days = [...byDay.keys()].sort().reverse().slice(0, TREND_HISTORY_DAYS);
  return days.length > 0 ? median(days.map((d) => byDay.get(d) as number)) : null;
}

export function differsFromTrend(valueLb: number, baseline: number | null): boolean {
  if (baseline === null) return false;
  const diff = Math.abs(valueLb - baseline);
  return diff > TREND_MAX_DIFF_LB || diff / baseline > TREND_MAX_DIFF_FRACTION;
}

export interface ReadingAssessment {
  flags: string[];
  confidence: Confidence;
}

/**
 * Review flags and confidence for `chosen` among the day's readings. The spread only looks at
 * readings of the same kind as the chosen one (morning vs. the rest), because a morning and an
 * evening weight normally differ by a few pounds.
 */
export function assessReading(
  candidates: WeightCandidate[],
  chosen: WeightCandidate,
  history: { localDate: LocalDate; valueLb: number }[],
  opts: { morningCutoffHour: number; expectedUnit?: WeightUnit },
): ReadingAssessment {
  const date = toLocalDate(chosen.takenAt);
  const morning = isMorning(chosen, opts.morningCutoffHour);
  const comparable = candidates
    .filter((c) => isPlausibleLb(c.valueLb))
    .filter((c) => isMorning(c, opts.morningCutoffHour) === morning)
    .map((c) => c.valueLb);
  // Rounded to the display precision so float noise (185 - 184.4 = 0.6000000000000227) can't flag.
  const spread = comparable.length > 1 ? round1(Math.max(...comparable) - Math.min(...comparable)) : 0;
  const plausible = isPlausibleLb(chosen.valueLb);
  const trendOff = plausible && differsFromTrend(chosen.valueLb, trendBaseline(history, date));
  const converted = chosen.rawUnit !== (opts.expectedUnit ?? 'lb') && chosen.rawUnit === 'kg';

  const flags: string[] = [];
  if (!plausible) flags.push('implausible_value');
  if (spread > SPREAD_FLAG_LB) flags.push('multiple_readings');
  if (!morning) flags.push('not_morning');
  if (chosen.readConfidence === 'low') flags.push('low_read_confidence');
  if (trendOff) flags.push('differs_from_trend');
  if (converted) flags.push('unit_converted');

  const trendConfidence: Confidence = trendOff || !plausible ? 'low' : 'high';
  return { flags, confidence: minConfidence(chosen.readConfidence, trendConfidence) };
}

/** Later readings of the same photo replace earlier ones; sorted by time. */
function mergeCandidates(existing: WeightCandidate[], incoming: WeightCandidate[]): WeightCandidate[] {
  const byAsset = new Map<string, WeightCandidate>();
  for (const c of [...existing, ...incoming]) byAsset.set(c.assetId, c);
  return [...byAsset.values()].sort(byTakenAt);
}

/**
 * `entry` with any of `candidates` from its day that it doesn't list yet (value, status and
 * updatedAt untouched), so an accepted day still shows a later photo the user may prefer.
 * Returns `entry` itself when nothing is new.
 */
export function attachCandidates(entry: WeightEntry, candidates: WeightCandidate[]): WeightEntry {
  const known = new Set(entry.candidates.map((c) => c.assetId));
  const extra = candidates.filter(
    (c) => isUsableCandidate(c) && !known.has(c.assetId) && toLocalDate(c.takenAt) === entry.localDate,
  );
  if (extra.length === 0) return entry;
  return { ...entry, candidates: [...entry.candidates, ...extra].sort(byTakenAt) };
}

function isUsableCandidate(c: WeightCandidate): boolean {
  return Number.isFinite(c.valueLb) && c.valueLb > 0 && Number.isFinite(c.takenAt);
}

/** Accepted values from the caller's history plus accepted entries among `existing`. */
function acceptedHistory(
  recent: BuildWeightOptions['recent'],
  existing: WeightEntry[],
): { localDate: LocalDate; valueLb: number }[] {
  const fromExisting = existing
    .filter((e) => (e.status === 'approved' || e.status === 'synced') && e.valueLb !== null)
    .map((e) => ({ localDate: e.localDate, valueLb: e.valueLb as number }));
  return [...fromExisting, ...recent];
}

function buildEntry(
  person: PersonLabel,
  date: LocalDate,
  candidates: WeightCandidate[],
  previous: WeightEntry | undefined,
  history: { localDate: LocalDate; valueLb: number }[],
  opts: BuildWeightOptions,
): WeightEntry | null {
  const chosen = chooseReading(candidates, opts.morningCutoffHour);
  if (!chosen) return null;
  const { flags, confidence } = assessReading(candidates, chosen, history, opts);
  return {
    id: weightEntryId(person, date),
    person,
    localDate: date,
    time: toLocalTime(chosen.takenAt),
    valueLb: round1(chosen.valueLb),
    chosenAssetId: chosen.assetId,
    source: sourceForAsset(chosen.assetId),
    confidence,
    candidates,
    flags,
    notes: previous?.notes ?? '',
    status: 'needs_review',
    syncError: null,
    updatedAt: opts.now,
  };
}

/**
 * For each day: choose the earliest reading before the morning cutoff (else the earliest
 * of the day); flags: `multiple_readings` (spread > 0.6 lb), `not_morning`,
 * `low_read_confidence`, `differs_from_trend` (> 4 lb or > 2.5 % from the median of the
 * last 7 accepted days), `unit_converted`. Confidence = min(read confidence, trend check).
 * Existing entries that are approved/synced are never overwritten (returned unchanged);
 * needs_review entries get the new candidates merged in.
 *
 * Also: `sync_error` counts as approved; a `rejected` day starts over from the new readings
 * (a fresh photo is new evidence); values outside 50–700 lb are only chosen as a last resort
 * and flagged `implausible_value`. Only days that have new candidates are returned.
 */
export function buildWeightEntries(
  person: PersonLabel,
  candidates: WeightCandidate[],
  existing: WeightEntry[],
  opts: BuildWeightOptions,
): WeightEntry[] {
  const byDay = new Map<LocalDate, WeightCandidate[]>();
  for (const c of candidates.filter(isUsableCandidate)) {
    const date = toLocalDate(c.takenAt);
    byDay.set(date, [...(byDay.get(date) ?? []), c]);
  }
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const history = acceptedHistory(opts.recent, existing);

  const out: WeightEntry[] = [];
  for (const date of [...byDay.keys()].sort()) {
    const previous = existingById.get(weightEntryId(person, date));
    if (previous && PROTECTED_STATUSES.includes(previous.status)) {
      out.push(previous);
      continue;
    }
    const incoming = byDay.get(date) as WeightCandidate[];
    const merged = mergeCandidates(previous?.status === 'needs_review' ? previous.candidates : [], incoming);
    const entry = buildEntry(person, date, merged, previous, history, opts);
    if (entry) out.push(entry);
  }
  return out;
}
