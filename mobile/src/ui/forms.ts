/** Pure input parsing/validation for forms and deep links (no native imports). */
import { addDays, isValidLocalDate } from '../lib/dates';
import { isAppsScriptExecUrl } from '../sync/webAppUrl';
import type { LocalDate, LocalTime, Macros, MealSlot, WeightUnit } from '../types';
import { formatInt, kgToLb } from './format';

/** Same bounds the sheet enforces for Weight Log rows. */
export const WEIGHT_LB_MIN = 50;
export const WEIGHT_LB_MAX = 700;
export const KCAL_MAX = 10_000;

/** `182.4`, `182,4` (comma decimal) or ` 182 ` → number; empty/invalid → null. */
export function parseDecimal(text: string): number | null {
  const cleaned = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Text shown in an editable number field for `value`. */
export function numberToInput(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const factor = 10 ** decimals;
  return String(Math.round(value * factor) / factor);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Weight typed in `unit` → lb, within the sheet's accepted range. */
export function parseWeightInput(text: string, unit: WeightUnit): Parsed<number> {
  const n = parseDecimal(text);
  if (n === null) return { ok: false, error: 'Enter a weight, e.g. 182.4' };
  const lb = unit === 'kg' ? kgToLb(n) : n;
  if (lb < WEIGHT_LB_MIN || lb > WEIGHT_LB_MAX) {
    return { ok: false, error: `That doesn't look like a body weight in ${unit}.` };
  }
  return { ok: true, value: Math.round(lb * 10) / 10 };
}

/** `7:05`, `07:05`, `705`, `0705` → `07:05`; null when not a valid time. */
export function parseTimeInput(text: string): LocalTime | null {
  const t = text.trim();
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function isValidTime(text: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
}

/** Validates a `YYYY-MM-DD` typed by the user; future dates are rejected. */
export function parseDateInput(text: string, today: LocalDate): Parsed<LocalDate> {
  const t = text.trim();
  if (!isValidLocalDate(t)) return { ok: false, error: 'Use the format YYYY-MM-DD.' };
  if (t > today) return { ok: false, error: "That date hasn't happened yet." };
  return { ok: true, value: t };
}

/** Whole number in [min, max] or an error naming the range. */
export function parseIntInRange(text: string, min: number, max: number, what: string): Parsed<number> {
  const n = parseDecimal(text);
  if (n === null || !Number.isInteger(n) || n < min || n > max) {
    return { ok: false, error: `${what} must be a whole number from ${min} to ${max}.` };
  }
  return { ok: true, value: n };
}

export interface MacroInputs {
  kcal: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
}

export function macrosToInputs(m: Macros): MacroInputs {
  return {
    kcal: numberToInput(m.kcal),
    proteinG: numberToInput(m.proteinG),
    carbsG: numberToInput(m.carbsG),
    fatG: numberToInput(m.fatG),
  };
}

/** Calories required; blank macros count as 0. */
export function parseMacroInputs(inputs: MacroInputs): Parsed<Macros> {
  const kcal = parseDecimal(inputs.kcal);
  if (kcal === null || kcal < 0 || kcal > KCAL_MAX) {
    return { ok: false, error: `Calories must be between 0 and ${formatInt(KCAL_MAX)}.` };
  }
  const grams: Record<'proteinG' | 'carbsG' | 'fatG', number> = { proteinG: 0, carbsG: 0, fatG: 0 };
  for (const key of ['proteinG', 'carbsG', 'fatG'] as const) {
    const raw = inputs[key].trim();
    if (!raw) continue;
    const n = parseDecimal(raw);
    if (n === null || n < 0 || n > 2000) return { ok: false, error: 'Protein, carbs and fat must be grams (0 or more).' };
    grams[key] = n;
  }
  return { ok: true, value: { kcal: Math.round(kcal), ...grams } };
}

/** Default meal slot for a wall-clock hour (used by the manual meal form). */
export function slotForHour(hour: number): MealSlot {
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 17 && hour < 22) return 'dinner';
  return 'snack';
}

/** Route params may be arrays when a key repeats; the first value wins. */
export function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * `diced://process-week` → `/process-week`, `diced:///review?x=1` → `/review?x=1`.
 * Returns null for links that aren't ours.
 */
export function pathFromDeepLink(url: string): string | null {
  const m = /^diced:\/\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  const rest = m[1].replace(/^\/+/, '');
  return `/${rest}`;
}

/** Quick-pick dates for the manual forms: today and the six days before. */
export function recentDates(today: LocalDate, count = 7): LocalDate[] {
  return Array.from({ length: count }, (_, i) => addDays(today, -i));
}

/** Hosts an Apps Script web app is served from. */
const APPS_SCRIPT_HOSTS = ['script.google.com', 'script.googleusercontent.com'];

export interface SheetUrlParts {
  /** Lower-case host name (after any `user@` part, which can disguise the real host). */
  host: string;
  /** Apps Script deployment id (`/macros/s/<id>/exec`), when the URL has one. */
  deploymentId: string | null;
}

/** Host and deployment id of an https URL; null when it isn't one. Regex-based (no URL polyfill needed). */
export function sheetUrlParts(url: string): SheetUrlParts | null {
  const m = /^https:\/\/(?:[^/?#@\s]*@)?([^/?#:@\s]+)(?::\d+)?([/?#][^\s]*)?$/i.exec(url.trim());
  if (!m) return null;
  const deploymentId = /\/s\/([^/?#\s]+)\/(?:exec|dev)\b/.exec(m[2] ?? '')?.[1] ?? null;
  return { host: m[1].toLowerCase(), deploymentId };
}

/** True for a Google Apps Script web-app address (what `Diced → Show app connection info` gives). */
export function isAppsScriptUrl(url: string): boolean {
  const parts = sheetUrlParts(url);
  return parts !== null && APPS_SCRIPT_HOSTS.includes(parts.host);
}

/** `script.google.com · deployment AKfycb…9xQw` — names where entries would be sent, for confirmations. */
export function describeSheetUrl(url: string): string {
  const parts = sheetUrlParts(url);
  if (!parts) return url.trim().length > 60 ? `${url.trim().slice(0, 57)}…` : url.trim();
  const id = parts.deploymentId;
  if (!id) return parts.host;
  const short = id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
  return `${parts.host} · deployment ${short}`;
}

/** Loose check before pinging: Apps Script web-app URLs live on script.google.com and end in /exec. */
export function sheetUrlHint(url: string): string | null {
  const t = url.trim();
  if (!t) return null;
  if (!/^https:\/\//i.test(t)) return 'The URL must start with https://';
  if (!isAppsScriptUrl(t)) {
    const host = sheetUrlParts(t)?.host ?? 'another site';
    return `This address is on ${host}, not Google Apps Script (script.google.com). Diced won’t connect to it — whoever runs it would receive your token, weigh-ins and meals. Use the link from your own sheet.`;
  }
  if (/\/dev\/?$/.test(t)) return 'This is the /dev test URL — use the deployment URL ending in /exec.';
  // Same rule the sheets client enforces before sending anything (sync/webAppUrl.ts).
  if (!isAppsScriptExecUrl(t)) return 'Use the web-app URL exactly as the sheet shows it: https://script.google.com/…/exec';
  return null;
}

/** What a Claude key test returns (`kind` is the AiApiErrorKind when the client reports it). */
export interface KeyTestResultLike {
  ok: boolean;
  message: string;
  kind?: string | null;
}

/**
 * Whether a key whose test failed may still be saved ("Save anyway"): only a rejected key is
 * refused. Offline, rate-limited, overloaded, permission or model-not-found failures don't mean the
 * key is wrong (the model id can be fixed in Settings afterwards).
 */
export function keyTestAllowsSave(result: KeyTestResultLike): boolean {
  if (result.ok) return true;
  if (typeof result.kind === 'string') return result.kind !== 'auth';
  // Without a kind, the rejected-key message is the one failure that means the key itself is bad.
  return !/key rejected/i.test(result.message);
}
