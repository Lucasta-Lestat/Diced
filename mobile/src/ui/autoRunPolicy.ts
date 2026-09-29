/** Pure decisions for the foreground "catch up" run (no native imports). */
import type { AppSettings, ProcessProgress } from '../types';
import type { AutoRunState } from './autoRun';
import { stageText } from './format';
import { pathFromDeepLink } from './forms';

/** Opening the app repeatedly shouldn't hit the sheet every time. */
export const FOREGROUND_SYNC_MIN_GAP_MS = 10 * 60_000;

export function shouldForegroundSync(lastSyncAt: number, now: number, justProcessed: boolean): boolean {
  if (justProcessed) return true;
  // A clock moved backwards makes the gap meaningless; sync rather than wait.
  if (now < lastSyncAt) return true;
  return now - lastSyncAt >= FOREGROUND_SYNC_MIN_GAP_MS;
}

/** `Estimating meals · 3/8` */
export function progressLine(progress: ProcessProgress | null): string {
  if (!progress) return 'Starting…';
  const count = progress.total > 0 ? ` · ${progress.done}/${progress.total}` : '';
  return `${stageText(progress.stage)}${count}`;
}

/**
 * Routes that show the pipeline's progress themselves (so the floating banner stays out of their
 * way). Whether the catch-up may process is decided by what is actually running, not the route.
 */
export function screenRunsPipeline(pathname: string): boolean {
  return pathname === '/process-week';
}

/** Whether the floating auto-run banner is on screen (Screen pads its content to stay clear of it). */
export function autoRunBannerShown(state: AutoRunState, pathname: string): boolean {
  if (state.phase === 'idle' || screenRunsPipeline(pathname)) return false;
  return !(state.phase === 'processing' && state.hidden);
}

/** `diced://process-week` (with or without a query) — the Shortcuts automation / reminder link. */
export function isProcessWeekLink(url: string): boolean {
  const path = pathFromDeepLink(url);
  return path !== null && path.split(/[?#]/)[0].replace(/\/+$/, '') === '/process-week';
}

/**
 * The weekly "read this week's photos" reminder (and the iPhone Shortcut that opens the same
 * link) only makes sense when photos are scanned automatically; in manual mode a run reads nothing.
 */
export function wantsWeeklyReminder(settings: Pick<AppSettings, 'classificationMode'>): boolean {
  return settings.classificationMode === 'cloud_thumbnails';
}
