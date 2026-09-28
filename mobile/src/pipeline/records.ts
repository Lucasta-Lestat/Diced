/** Pure helpers for photo records and scan windows. OWNER: nutrition/pipeline builder. */
import { toLocalDate } from '../lib/dates';
import { exclusionReason } from '../photos/heuristics';
import type { PhotoAsset, PhotoCategory, PhotoRecord } from '../types';

/** Category confidence stored when the user chose the category (quick log / picked photos). */
export const PRESET_CATEGORY_CONFIDENCE = 1;
/** Model confidences are capped just below the preset marker so the two stay distinguishable. */
export const MAX_MODEL_CONFIDENCE = 0.99;
/** Failed / unfinished photos are retried by later runs for this many days. */
export const RETRY_LOOKBACK_DAYS = 35;

export function modelConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(MAX_MODEL_CONFIDENCE, Math.max(0, confidence));
}

/** True when the user chose the photo's category (so manual mode may process it). */
export function hasPresetCategory(record: PhotoRecord): boolean {
  return record.origin === 'capture' || record.categoryConfidence === PRESET_CATEGORY_CONFIDENCE;
}

/** A scanned library photo as a new `photos` row (excluded photos are never sent anywhere). */
export function photoRecordFromAsset(asset: PhotoAsset, now: number): PhotoRecord {
  const preset = asset.presetCategory ?? null;
  return {
    assetId: asset.id,
    uri: asset.uri,
    creationTime: asset.creationTime,
    localDate: toLocalDate(asset.creationTime),
    origin: asset.origin,
    excludedReason: exclusionReason(asset),
    category: preset,
    categoryConfidence: preset ? PRESET_CATEGORY_CONFIDENCE : null,
    classifiedAt: preset ? now : null,
    processedAt: null,
    error: null,
  };
}

/** A photo whose category the user already chose (quick-log capture or hand-picked). */
export function presetPhotoRecord(
  photo: { assetId: string; uri: string; creationTime: number; origin: PhotoRecord['origin'] },
  category: PhotoCategory,
  now: number,
): PhotoRecord {
  return {
    assetId: photo.assetId,
    uri: photo.uri,
    creationTime: photo.creationTime,
    localDate: toLocalDate(photo.creationTime),
    origin: photo.origin,
    excludedReason: null,
    category,
    categoryConfidence: PRESET_CATEGORY_CONFIDENCE,
    classifiedAt: now,
    processedAt: null,
    error: null,
  };
}

/**
 * The next `lastScanEnd` after a complete run over `window`, or null to leave it. Default
 * windows always advance (they deliberately skip anything older than 35 days); an explicit
 * window only advances it when it continues from the last scan without leaving a gap.
 */
export function nextLastScanEnd(
  lastScanEnd: number | null,
  window: { startMs: number; endMs: number },
  explicitWindow: boolean,
): number | null {
  if (lastScanEnd !== null && window.endMs <= lastScanEnd) return null;
  if (explicitWindow && lastScanEnd !== null && window.startMs > lastScanEnd) return null;
  return window.endMs;
}
