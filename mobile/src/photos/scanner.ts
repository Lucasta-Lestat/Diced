/**
 * Photo library access (expo-media-library). OWNER: photos/scheduling builder.
 */
import type { PhotoAsset } from '../types';

export type PhotoPermission = 'granted_all' | 'granted_limited' | 'denied' | 'undetermined';

export async function getPhotoPermission(): Promise<PhotoPermission> {
  throw new Error('not implemented');
}

/** Ask for read access to photos (no write, no location). */
export async function requestPhotoPermission(): Promise<PhotoPermission> {
  throw new Error('not implemented');
}

/** All photos (not videos) created in [startMs, endMs), oldest first, paging through the library. */
export async function listPhotosInRange(startMs: number, endMs: number): Promise<PhotoAsset[]> {
  throw new Error('not implemented');
}

/**
 * A `file://` URI readable by expo-image-manipulator for the asset (resolves `ph://`
 * on iOS via getAssetInfoAsync localUri). Returns null if the asset no longer exists.
 */
export async function resolveReadableUri(assetId: string, fallbackUri: string): Promise<string | null> {
  throw new Error('not implemented');
}
