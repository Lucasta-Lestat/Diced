/** Photo processing state (table `photos`). OWNER: data-layer builder. */
import type { PhotoCategory, PhotoRecord } from '../types';

/** Insert records that are not yet known (existing rows are left untouched). Returns # inserted. */
export async function insertNewPhotos(records: PhotoRecord[]): Promise<number> {
  throw new Error('not implemented');
}

export async function getPhoto(assetId: string): Promise<PhotoRecord | null> {
  throw new Error('not implemented');
}

export async function getPhotos(assetIds: string[]): Promise<PhotoRecord[]> {
  throw new Error('not implemented');
}

/** Photos in [startMs, endMs) that are not excluded and not yet classified, oldest first. */
export async function listUnclassified(startMs: number, endMs: number): Promise<PhotoRecord[]> {
  throw new Error('not implemented');
}

export async function setClassification(
  assetId: string,
  category: PhotoCategory,
  confidence: number,
): Promise<void> {
  throw new Error('not implemented');
}

/** Classified photos in the window with one of `categories` and processedAt == null, oldest first. */
export async function listUnprocessed(
  startMs: number,
  endMs: number,
  categories: PhotoCategory[],
): Promise<PhotoRecord[]> {
  throw new Error('not implemented');
}

export async function markProcessed(assetIds: string[]): Promise<void> {
  throw new Error('not implemented');
}

export async function setPhotoError(assetId: string, error: string | null): Promise<void> {
  throw new Error('not implemented');
}

/** Counts by category in a window (for the home screen). */
export async function countByCategory(
  startMs: number,
  endMs: number,
): Promise<Record<PhotoCategory | 'unclassified' | 'excluded', number>> {
  throw new Error('not implemented');
}
