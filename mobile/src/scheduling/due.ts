/** Pure scheduling math. OWNER: photos/scheduling builder. */
import type { AppSettings } from '../types';

/** Next occurrence (ms) of the weekly slot (weekday/hour/minute, local) strictly after `now`. */
export function nextWeeklySlot(settings: AppSettings, now: number): number {
  throw new Error('not implemented');
}

/** Most recent occurrence (ms) of the weekly slot at or before `now`. */
export function previousWeeklySlot(settings: AppSettings, now: number): number {
  throw new Error('not implemented');
}

/** True when the weekly slot has passed since the last automatic run (or there never was one). */
export function isWeeklyRunDue(settings: AppSettings, now: number): boolean {
  throw new Error('not implemented');
}

/** True when processDaily is on and no automatic run happened in the last 20 hours. */
export function isDailyRunDue(settings: AppSettings, now: number): boolean {
  throw new Error('not implemented');
}

/**
 * Scan window for the next run: from settings.lastScanEnd (or 8 days before now on first
 * run), to now. Never longer than 35 days (older photos need an explicit manual range).
 */
export function nextScanWindow(settings: AppSettings, now: number): { startMs: number; endMs: number } {
  throw new Error('not implemented');
}
