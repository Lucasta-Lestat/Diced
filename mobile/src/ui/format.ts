/**
 * Display strings for the UI. Pure (no native imports) and locale-independent so the
 * labels are identical on every phone and in tests.
 */
import { addDays, formatDayLabel } from '../lib/dates';
import type {
  Confidence,
  EntryStatus,
  EstimateMethod,
  ItemSource,
  LocalDate,
  Macros,
  MealSlot,
  ProcessProgress,
  ProcessResult,
  WeightUnit,
} from '../types';

export const EM_DASH = '—';
const MINUS = '−';
export const KG_PER_LB = 0.45359237;

/** `1234.4` → `1,234` (always comma-grouped, never locale-dependent). */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return EM_DASH;
  const rounded = Math.round(n);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rounded < 0 ? `${MINUS}${digits}` : digits;
}

export function formatKcal(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? EM_DASH : `${formatInt(n)} kcal`;
}

/** Half-width of the plausible range, e.g. `±120`; null when there is no usable range. */
export function kcalPlusMinus(low: number, high: number): string | null {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
  return `±${formatInt((high - low) / 2)}`;
}

/** `650 kcal ±120` (or just `650 kcal`). */
export function formatKcalWithRange(kcal: number, low: number | null, high: number | null): string {
  const range = low !== null && high !== null ? kcalPlusMinus(low, high) : null;
  return range ? `${formatKcal(kcal)} ${range}` : formatKcal(kcal);
}

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB;
}

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB;
}

function oneDecimal(n: number): string {
  const fixed = (Math.round(n * 10) / 10).toFixed(1);
  return fixed.startsWith('-') ? `${MINUS}${fixed.slice(1)}` : fixed;
}

/** Weight stored in lb, shown in lb or kg with one decimal. */
export function formatWeight(lb: number | null | undefined, unit: WeightUnit = 'lb'): string {
  if (lb === null || lb === undefined || !Number.isFinite(lb)) return EM_DASH;
  return unit === 'kg' ? `${oneDecimal(lbToKg(lb))} kg` : `${oneDecimal(lb)} lb`;
}

/** Signed change, e.g. `+0.4 lb` / `−1.2 lb`. */
export function formatWeightDelta(deltaLb: number, unit: WeightUnit = 'lb'): string {
  if (!Number.isFinite(deltaLb)) return EM_DASH;
  const value = unit === 'kg' ? lbToKg(deltaLb) : deltaLb;
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${oneDecimal(rounded)} ${unit}`;
}

export function formatGrams(g: number | null | undefined): string {
  return g === null || g === undefined || !Number.isFinite(g) ? EM_DASH : `${formatInt(g)} g`;
}

/** `P 32 g · C 45 g · F 18 g` */
export function formatMacros(m: Pick<Macros, 'proteinG' | 'carbsG' | 'fatG'>): string {
  return `P ${formatInt(m.proteinG)} g · C ${formatInt(m.carbsG)} g · F ${formatInt(m.fatG)} g`;
}

/** `Today`, `Yesterday`, else `Mon, Sep 28`. */
export function dayLabel(date: LocalDate, today: LocalDate): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return formatDayLabel(date);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `9, 5` → `09:05` */
export function formatClock(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** ISO weekday (1 = Monday … 7 = Sunday). */
export function weekdayName(isoWeekday: number): string {
  return WEEKDAYS[(((Math.round(isoWeekday) - 1) % 7) + 7) % 7];
}

export function weekdayShort(isoWeekday: number): string {
  return weekdayName(isoWeekday).slice(0, 3);
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInt(n)} ${n === 1 ? singular : pluralForm}`;
}

/** `just now`, `5 min ago`, `3 h ago`, `2 days ago`, then the date. */
export function relativeTime(ms: number, now: number): string {
  const diff = now - ms;
  if (!Number.isFinite(diff)) return EM_DASH;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  const d = new Date(ms);
  return formatDayLabel(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
}

const FLAG_TEXT: Record<string, string> = {
  differs_from_trend: 'Differs from your recent trend',
  unit_converted: 'Converted from kg',
  multiple_readings: 'Several readings that day',
  low_read_confidence: 'Display was hard to read',
  not_morning: 'Not a morning weigh-in',
};

/** Review flag → human text; unknown flags become `Some flag`. */
export function flagText(flag: string): string {
  const known = FLAG_TEXT[flag];
  if (known) return known;
  const words = flag.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : flag;
}

export function confidenceText(c: Confidence): string {
  switch (c) {
    case 'high':
      return 'High confidence';
    case 'medium':
      return 'Medium confidence';
    case 'low':
      return 'Low confidence';
  }
}

export function statusText(status: EntryStatus): string {
  switch (status) {
    case 'needs_review':
      return 'Needs review';
    case 'approved':
      return 'Approved · waiting to sync';
    case 'rejected':
      return 'Rejected';
    case 'synced':
      return 'In the sheet';
    case 'sync_error':
      return 'Sync failed';
  }
}

export function methodText(method: EstimateMethod): string {
  switch (method) {
    case 'photo':
      return 'Estimated from photo';
    case 'label':
      return 'Read from nutrition label';
    case 'barcode':
      return 'Barcode lookup';
    case 'library':
      return 'Usual meal';
    case 'restaurant':
      return 'Published nutrition';
    case 'manual':
      return 'Typed in';
  }
}

export function itemSourceText(source: ItemSource): string {
  switch (source) {
    case 'model':
      return 'Claude estimate';
    case 'usda':
      return 'USDA';
    case 'label':
      return 'Label';
    case 'openfoodfacts':
      return 'Open Food Facts';
    case 'library':
      return 'Usual meal';
    case 'web':
      return 'Published';
    case 'user':
      return 'Edited';
  }
}

export const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export function slotText(slot: MealSlot): string {
  return slot.charAt(0).toUpperCase() + slot.slice(1);
}

export function stageText(stage: ProcessProgress['stage']): string {
  switch (stage) {
    case 'scanning':
      return 'Looking through your photos';
    case 'classifying':
      return 'Finding scale and food photos';
    case 'reading_scale':
      return 'Reading the scale';
    case 'estimating_meals':
      return 'Estimating meals';
    case 'saving':
      return 'Saving';
    case 'done':
      return 'Done';
  }
}

/** One-line summary of a processing run. */
export function runSummary(r: Pick<ProcessResult, 'weightEntriesCreated' | 'mealsCreated' | 'photosScanned' | 'partial' | 'errors'>): string {
  const found: string[] = [];
  if (r.weightEntriesCreated > 0) found.push(plural(r.weightEntriesCreated, 'weigh-in'));
  if (r.mealsCreated > 0) found.push(plural(r.mealsCreated, 'meal'));
  const head = found.length
    ? `Found ${found.join(' and ')}`
    : `No new weigh-ins or meals in ${plural(r.photosScanned, 'photo')}`;
  const tail: string[] = [];
  if (r.partial) tail.push('the rest continues next run');
  if (r.errors.length) tail.push(plural(r.errors.length, 'error'));
  return tail.length ? `${head} (${tail.join(', ')})` : head;
}

/** `Synced 2 weigh-ins and 5 meals` style summary. */
export function syncSummary(r: { weightsSynced: number; mealsSynced: number; deletesSynced: number; errors: string[] }): string {
  const parts: string[] = [];
  if (r.weightsSynced) parts.push(plural(r.weightsSynced, 'weigh-in'));
  if (r.mealsSynced) parts.push(plural(r.mealsSynced, 'meal'));
  if (r.deletesSynced) parts.push(plural(r.deletesSynced, 'removal'));
  const head = parts.length ? `Synced ${parts.join(', ')}` : 'Everything is already in the sheet';
  return r.errors.length ? `${head} · ${plural(r.errors.length, 'error')}` : head;
}
