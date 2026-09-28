/** Pure scheduling math. OWNER: photos/scheduling builder. */
import { addDays, mondayOf, toLocalDate } from '../lib/dates';
import type { AppSettings, LocalDate } from '../types';

/** A daily run is due once no automatic run happened for this long. */
export const DAILY_RUN_GAP_MS = 20 * 60 * 60 * 1000;
/** First run (no lastScanEnd yet) looks back this many calendar days. */
export const FIRST_RUN_LOOKBACK_DAYS = 8;
/** Longest window a scheduled run will scan; older photos need an explicit manual range. */
export const MAX_SCAN_WINDOW_DAYS = 35;

type Schedule = Pick<AppSettings, 'scheduleWeekday' | 'scheduleHour' | 'scheduleMinute'>;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Local wall-clock instant of the slot on `date`. Built with the Date constructor so DST
 * transitions are handled by the platform (a slot inside a spring-forward gap moves forward).
 */
function slotOn(date: LocalDate, hour: number, minute: number): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
}

/** The slot in the ISO week (Mon–Sun) containing `now`, plus the date it falls on. */
function slotInWeekOf(settings: Schedule, now: number): { date: LocalDate; at: number } {
  const weekday = clampInt(settings.scheduleWeekday, 1, 7, 1);
  const hour = clampInt(settings.scheduleHour, 0, 23, 9);
  const minute = clampInt(settings.scheduleMinute, 0, 59, 0);
  const date = addDays(mondayOf(toLocalDate(now)), weekday - 1);
  return { date, at: slotOn(date, hour, minute) };
}

function slotShifted(settings: Schedule, date: LocalDate, weeks: number): number {
  const hour = clampInt(settings.scheduleHour, 0, 23, 9);
  const minute = clampInt(settings.scheduleMinute, 0, 59, 0);
  return slotOn(addDays(date, weeks * 7), hour, minute);
}

/** Next occurrence (ms) of the weekly slot (weekday/hour/minute, local) strictly after `now`. */
export function nextWeeklySlot(settings: AppSettings, now: number): number {
  const { date, at } = slotInWeekOf(settings, now);
  return at > now ? at : slotShifted(settings, date, 1);
}

/** Most recent occurrence (ms) of the weekly slot at or before `now`. */
export function previousWeeklySlot(settings: AppSettings, now: number): number {
  const { date, at } = slotInWeekOf(settings, now);
  return at <= now ? at : slotShifted(settings, date, -1);
}

/** A last-run timestamp from the future (clock was changed) can't be trusted. */
function hasUsableLastRun(settings: AppSettings, now: number): settings is AppSettings & { lastAutoRunAt: number } {
  return settings.lastAutoRunAt !== null && Number.isFinite(settings.lastAutoRunAt) && settings.lastAutoRunAt <= now;
}

/** True when the weekly slot has passed since the last automatic run (or there never was one). */
export function isWeeklyRunDue(settings: AppSettings, now: number): boolean {
  if (!hasUsableLastRun(settings, now)) return true;
  return previousWeeklySlot(settings, now) > settings.lastAutoRunAt;
}

/** True when processDaily is on and no automatic run happened in the last 20 hours. */
export function isDailyRunDue(settings: AppSettings, now: number): boolean {
  if (!settings.processDaily) return false;
  if (!hasUsableLastRun(settings, now)) return true;
  return now - settings.lastAutoRunAt >= DAILY_RUN_GAP_MS;
}

/** `ms` moved by whole calendar days, keeping the local wall-clock time (DST-safe). */
export function shiftLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

/**
 * Scan window for the next run: from settings.lastScanEnd (or 8 days before now on first
 * run), to now. Never longer than 35 days (older photos need an explicit manual range).
 */
export function nextScanWindow(settings: AppSettings, now: number): { startMs: number; endMs: number } {
  const earliest = shiftLocalDays(now, -MAX_SCAN_WINDOW_DAYS);
  const last = settings.lastScanEnd;
  const from = last !== null && Number.isFinite(last) ? last : shiftLocalDays(now, -FIRST_RUN_LOOKBACK_DAYS);
  // A lastScanEnd in the future (clock changed) yields an empty window rather than an inverted one.
  const startMs = Math.min(now, Math.max(earliest, from));
  return { startMs, endMs: now };
}
