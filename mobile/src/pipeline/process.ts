/**
 * The processing pipeline. OWNER: nutrition/pipeline builder.
 * scan → exclude (heuristics) → classify thumbnails → read scales → group & estimate meals
 * → reconcile → store entries as needs_review → notify. Resumable: every step persists
 * per-photo state, so a run cut short by the time budget continues next time.
 */
import type { ProcessProgress, ProcessResult, RunReason } from '../types';

export interface ProcessOptions {
  reason: RunReason;
  /** Explicit window; default = scheduling/due.nextScanWindow(settings, now). */
  window?: { startMs: number; endMs: number };
  /** Stop starting new work after this many ms (background: ~25 s iOS, ~8 min Android). */
  timeBudgetMs?: number;
  onProgress?: (p: ProcessProgress) => void;
  /** Abort signal from the UI. */
  signal?: AbortSignal;
}

/** Single-flight: a second call while running returns the in-progress promise. */
export async function processPhotos(opts: ProcessOptions): Promise<ProcessResult> {
  throw new Error('not implemented');
}

/** True while a run is in progress. */
export function isProcessing(): boolean {
  throw new Error('not implemented');
}

/**
 * Quick-log: a photo just taken in the app with a known category. Stores it
 * (origin 'capture'), reads/estimates immediately, returns the created entry id.
 */
export async function processCapturedPhoto(
  uri: string,
  category: 'scale' | 'food',
  takenAt: number,
): Promise<{ kind: 'weight' | 'meal'; id: string }> {
  throw new Error('not implemented');
}

/**
 * Hand-picked photos (manual mode or "add photos" in review): insert as library photos
 * with a preset category and process them now.
 */
export async function processPickedPhotos(
  assets: { assetId: string; uri: string; creationTime: number }[],
  category: 'scale' | 'food',
): Promise<ProcessResult> {
  throw new Error('not implemented');
}
