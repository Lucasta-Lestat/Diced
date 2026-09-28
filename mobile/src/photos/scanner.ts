/**
 * Photo library access (expo-media-library). OWNER: photos/scheduling builder.
 *
 * Uses the SDK 57 object API (`Query`, `Asset`); the old function API (getAssetsAsync,
 * getAssetInfoAsync) throws at runtime from the package root.
 */
import { File } from 'expo-file-system';
import {
  Asset,
  AssetField,
  getPermissionsAsync,
  MediaType,
  Query,
  requestPermissionsAsync,
  type AssetMetadata,
} from 'expo-media-library';
import { Platform } from 'react-native';
import { logger } from '../lib/log';
import type { PhotoAsset } from '../types';
import { isMissingAssetError, normalizeRange, toPhotoAsset, toPhotoPermission } from './assetMapping';

export type PhotoPermission = 'granted_all' | 'granted_limited' | 'denied' | 'undetermined';

/** Page size for library queries; keeps each native call's payload small. */
const PAGE_SIZE = 500;
/** Parallel per-asset native calls on iOS (media subtypes). */
const SUBTYPE_CONCURRENCY = 8;
/** Android 11 (API 30) is the first release where media file paths are readable directly. */
const ANDROID_FILE_PATH_MIN_API = 30;

const log = logger('photos');

/**
 * Read access to photos only: not write-only, no video/audio (Android granular permission), and
 * no media location (ACCESS_MEDIA_LOCATION is only requested when declared in the manifest).
 */
const WRITE_ONLY = false;
const PHOTOS_ONLY = ['photo'] as const;

export async function getPhotoPermission(): Promise<PhotoPermission> {
  return toPhotoPermission(await getPermissionsAsync(WRITE_ONLY, [...PHOTOS_ONLY]));
}

/** Ask for read access to photos (no write, no location). */
export async function requestPhotoPermission(): Promise<PhotoPermission> {
  return toPhotoPermission(await requestPermissionsAsync(WRITE_ONLY, [...PHOTOS_ONLY]));
}

function pageQuery(startMs: number, endMs: number, offset: number): Query {
  // Native filters take integer ms; ceil keeps both bounds exact for [start, end).
  return new Query()
    .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
    .gte(AssetField.CREATION_TIME, Math.ceil(startMs))
    .lt(AssetField.CREATION_TIME, Math.ceil(endMs))
    .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
    .limit(PAGE_SIZE)
    .offset(offset);
}

async function queryAllMetadata(startMs: number, endMs: number): Promise<AssetMetadata[]> {
  const all: AssetMetadata[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await pageQuery(startMs, endMs, offset).exeForMetadata();
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** iOS only (screenshots are flagged by subtype, not filename). Failures just mean "unknown". */
async function mediaSubtypesOf(id: string): Promise<string[]> {
  if (Platform.OS !== 'ios') return [];
  try {
    return await new Asset(id).getMediaSubtypes();
  } catch (e) {
    log.debug('media subtypes unavailable', e);
    return [];
  }
}

/** All photos (not videos) created in [startMs, endMs), oldest first, paging through the library. */
export async function listPhotosInRange(startMs: number, endMs: number): Promise<PhotoAsset[]> {
  if (!(endMs > startMs)) return [];
  const metadata = await queryAllMetadata(startMs, endMs);
  const images = metadata.filter((m) => m.mediaType === MediaType.IMAGE && m.creationTime !== null);
  const assets = await mapLimit(images, SUBTYPE_CONCURRENCY, async (m) =>
    toPhotoAsset(m, await mediaSubtypesOf(m.id)),
  );
  return normalizeRange(assets, startMs, endMs);
}

function localFileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/**
 * On iOS `getUri()` resolves the full-size original (downloading it from iCloud if needed).
 * On Android it is the MediaStore file path, which Android 10 won't let us open directly,
 * so there we keep the content:// URI (the asset id) once the asset is known to exist.
 */
function readableUriFor(assetId: string, resolved: string): string {
  if (Platform.OS === 'android' && Number(Platform.Version) < ANDROID_FILE_PATH_MIN_API) {
    return assetId;
  }
  return resolved;
}

/**
 * A `file://` URI readable by expo-image-manipulator for the asset (resolves `ph://`
 * on iOS via getAssetInfoAsync localUri). Returns null if the asset no longer exists.
 */
export async function resolveReadableUri(assetId: string, fallbackUri: string): Promise<string | null> {
  // Quick-log captures live in the app's own storage, not in the media library.
  if (fallbackUri.startsWith('file://')) return localFileExists(fallbackUri) ? fallbackUri : null;

  try {
    return readableUriFor(assetId, await new Asset(assetId).getUri());
  } catch (e) {
    if (isMissingAssetError(e)) return null;
    throw e;
  }
}
