/**
 * Photo library access (expo-media-library). OWNER: photos/scheduling builder.
 *
 * Uses the SDK 57 object API (`Query`, `Asset`); the old function API (getAssetsAsync,
 * getAssetInfoAsync) throws at runtime from the package root.
 */
import { File, Paths } from 'expo-file-system';
import {
  Album,
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
import { appFileParts, isLibraryAssetId } from './appFiles';
import { isMissingAssetError, normalizeRange, toPhotoAsset, toPhotoPermission } from './assetMapping';

export type PhotoPermission = 'granted_all' | 'granted_limited' | 'denied' | 'undetermined';

/** Page size for library queries; keeps each native call's payload small. */
const PAGE_SIZE = 500;
/** Parallel per-asset native calls on iOS (media subtypes). */
const SUBTYPE_CONCURRENCY = 8;
/** Android 11 (API 30) is the first release where media file paths are readable directly. */
const ANDROID_FILE_PATH_MIN_API = 30;

/**
 * Albums messaging apps save received images into (iOS albums / Android folders). On iOS these
 * images get ordinary IMG_1234 file names, so the album is the only on-device signal.
 */
export const MESSAGING_ALBUMS = [
  'WhatsApp',
  'WhatsApp Images',
  'WhatsApp Business',
  'WhatsApp Business Images',
  'Signal',
  'Telegram',
  'Telegram Images',
  'Messenger',
  'Viber',
  'Viber Images',
  'WeChat',
] as const;

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

async function queryAllMetadata(startMs: number, endMs: number, album?: Album): Promise<AssetMetadata[]> {
  const all: AssetMetadata[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = pageQuery(startMs, endMs, offset);
    const page = await (album ? query.album(album) : query).exeForMetadata();
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

/**
 * Ids of photos in [startMs, endMs) that sit in a messaging app's album. Best-effort: a failed
 * lookup just means "none found" (the file-name check still applies).
 */
async function messagingAlbumAssetIds(startMs: number, endMs: number): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const title of MESSAGING_ALBUMS) {
    try {
      const album = await Album.get(title);
      if (!album) continue;
      for (const m of await queryAllMetadata(startMs, endMs, album)) ids.add(m.id);
    } catch (e) {
      log.debug(`album "${title}" unavailable`, e);
    }
  }
  return ids;
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
  const messaging = images.length > 0 ? await messagingAlbumAssetIds(startMs, endMs) : new Set<string>();
  const assets = await mapLimit(images, SUBTYPE_CONCURRENCY, async (m) => {
    const asset = toPhotoAsset(m, await mediaSubtypesOf(m.id));
    return messaging.has(m.id) ? { ...asset, fromMessagingAlbum: true } : asset;
  });
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
 * The stored `file://` URI of a photo the app keeps itself, as it is now, or null when the file
 * is gone. iOS moves the app's data container on app updates and reinstalls, so an absolute
 * `…/Application/<old id>/Documents/captures/x.jpg` is looked up again in today's documents folder.
 */
export function currentAppFileUri(uri: string): string | null {
  if (localFileExists(uri)) return uri;
  const parts = appFileParts(uri);
  if (!parts) return null;
  try {
    const moved = new File(Paths.document, parts.dir, parts.name).uri;
    return moved !== uri && localFileExists(moved) ? moved : null;
  } catch {
    return null;
  }
}

/**
 * A `file://` URI readable by expo-image-manipulator for the asset (resolves `ph://` on iOS to the
 * original, downloading it from iCloud if needed). Returns null if the photo no longer exists.
 * A stored file copy (quick-log capture, or the picker's copy of a hand-picked photo) is used while
 * it exists; the picker's copy lives in the cache, which the OS may purge, so a hand-picked
 * library photo then falls back to the library asset itself.
 */
export async function resolveReadableUri(assetId: string, fallbackUri: string): Promise<string | null> {
  if (fallbackUri.startsWith('file://')) {
    const local = currentAppFileUri(fallbackUri);
    if (local) return local;
    // Captures and picks without a library id live only in app storage.
    if (!isLibraryAssetId(assetId)) return null;
  }

  try {
    return readableUriFor(assetId, await new Asset(assetId).getUri());
  } catch (e) {
    if (isMissingAssetError(e)) return null;
    throw e;
  }
}

/**
 * Synchronous: a URI expo-image can display for a stored photo (thumbnails), with the same
 * fallbacks as resolveReadableUri — the relocated app file, else the library asset id (expo-image
 * loads `ph://` and `content://` directly). Returns the stored URI when nothing better exists.
 */
export function displayUriFor(photo: { assetId: string; uri: string }): string {
  if (!photo.uri.startsWith('file://')) return photo.uri;
  const local = currentAppFileUri(photo.uri);
  if (local) return local;
  return isLibraryAssetId(photo.assetId) ? photo.assetId : photo.uri;
}
