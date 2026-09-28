/**
 * Pure mapping between expo-media-library results and our types (no native imports, so
 * Jest can test it). OWNER: photos/scheduling builder.
 */
import type { PhotoAsset } from '../types';
import type { PhotoPermission } from './scanner';

/** The subset of expo-media-library's PermissionResponse we rely on. */
export interface MediaPermissionLike {
  status: string;
  granted: boolean;
  accessPrivileges?: 'all' | 'limited' | 'none';
}

/** The subset of expo-media-library's AssetMetadata we rely on. */
export interface AssetMetadataLike {
  id: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  creationTime: number | null;
}

export function toPhotoPermission(response: MediaPermissionLike): PhotoPermission {
  // Android 14 "selected photos" reports granted + limited, like iOS limited access.
  if (response.granted || response.status === 'granted') {
    return response.accessPrivileges === 'limited' ? 'granted_limited' : 'granted_all';
  }
  return response.status === 'undetermined' ? 'undetermined' : 'denied';
}

export function toPhotoAsset(meta: AssetMetadataLike, mediaSubtypes: string[] = []): PhotoAsset {
  return {
    id: meta.id,
    // iOS: ph://<localIdentifier>, Android: content://media/… — both load in expo-image and
    // expo-image-manipulator without copying the original.
    uri: meta.id,
    creationTime: meta.creationTime ?? 0,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    filename: meta.filename ?? null,
    mediaSubtypes,
    origin: 'library',
  };
}

/** Keeps assets inside [startMs, endMs), drops duplicate ids, sorts oldest first (stable by id). */
export function normalizeRange(assets: PhotoAsset[], startMs: number, endMs: number): PhotoAsset[] {
  const seen = new Set<string>();
  const out: PhotoAsset[] = [];
  for (const a of assets) {
    if (a.creationTime < startMs || a.creationTime >= endMs || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out.sort((a, b) => a.creationTime - b.creationTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * True when a media-library error means the asset is gone (deleted, or no longer shared with
 * the app under limited access) — as opposed to a transient failure such as an iCloud
 * download that should be retried.
 */
export function isMissingAssetError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && /NOT_FOUND/i.test(code)) return true;
  return typeof message === 'string' && /not found|no longer accessible/i.test(message);
}
