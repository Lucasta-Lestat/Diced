/** Pure decisions for the foreground "catch up" run (no native imports). */
import type { ProcessProgress } from '../types';
import { stageText } from './format';

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

/** Deep-link paths that run the pipeline themselves (the foreground catch-up stays out of their way). */
export function screenRunsPipeline(pathname: string): boolean {
  return pathname === '/process-week';
}
