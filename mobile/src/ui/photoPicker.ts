/** Camera / photo-library pickers for Quick log (expo-image-picker). */
import * as ImagePicker from 'expo-image-picker';
import { Asset, AssetField, MediaType, Query } from 'expo-media-library';
import { Platform } from 'react-native';
import { errorMessage, logger } from '../lib/log';
import { getPhotoPermission } from '../photos/scanner';
import {
  exifCaptureTime,
  fallbackPickedId,
  LIBRARY_MATCH_WINDOW_MS,
  libraryIdFromPicker,
  matchLibraryAsset,
  type LibraryMetaLike,
  type PickedAssetLike,
} from './pickerMapping';

const log = logger('photoPicker');
/** Upper bound on library entries read to find one picked photo (72 h of photos). */
const LIBRARY_MATCH_LIMIT = 2_000;

export interface PickedPhoto {
  assetId: string;
  /** Readable file copy made by the picker (works even with limited library access). */
  uri: string;
  creationTime: number;
  /** true when no capture time was available and "now" was used. */
  timeGuessed: boolean;
}

export const MAX_PICK = 12;

/** Opens the camera; null when the user cancels. Throws with a readable message if access is off. */
export async function takePhoto(): Promise<{ uri: string; takenAt: number } | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Camera access is off. Turn it on in the system Settings → Diced → Camera.');
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
  if (result.canceled || result.assets.length === 0) return null;
  return { uri: result.assets[0].uri, takenAt: Date.now() };
}

/** Opens the system photo picker (no library permission needed); [] when cancelled. */
export async function pickPhotos(limit: number = MAX_PICK): Promise<PickedPhoto[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    orderedSelection: true,
    // Only read for the capture time; EXIF never leaves the phone (images are re-encoded).
    exif: true,
    quality: 1,
  });
  if (result.canceled) return [];
  return Promise.all(result.assets.map(toPickedPhoto));
}

async function toPickedPhoto(asset: PickedAssetLike): Promise<PickedPhoto> {
  const androidApi = Platform.OS === 'android' ? Number(Platform.Version) : 0;
  const exifTime = exifCaptureTime(asset.exif);
  let libraryId = libraryIdFromPicker(asset.assetId, Platform.OS, androidApi);
  let fromLibrary = libraryId ? await libraryCreationTime(libraryId) : null;
  // Android's system photo picker (the default since Android 13, and on 11-12 via Play services)
  // reports no MediaStore id; look the photo up so it gets the same id the scanner stores.
  if (!libraryId && Platform.OS === 'android') {
    const found = await findInLibrary(asset, exifTime);
    if (found) {
      libraryId = found.id;
      fromLibrary = found.creationTime !== null && found.creationTime > 0 ? found.creationTime : null;
    }
  }
  const time = fromLibrary ?? exifTime;
  return {
    assetId: libraryId ?? fallbackPickedId(asset),
    uri: asset.uri,
    creationTime: time ?? Date.now(),
    timeGuessed: time === null,
  };
}

/** Library entry for a picked photo (by file name, then size + capture second); null without read access. */
async function findInLibrary(asset: PickedAssetLike, takenAt: number | null): Promise<LibraryMetaLike | null> {
  try {
    const permission = await getPhotoPermission();
    if (permission !== 'granted_all' && permission !== 'granted_limited') return null;
    const center = takenAt ?? Date.now();
    const candidates = await new Query()
      .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
      .gte(AssetField.CREATION_TIME, Math.floor(center - LIBRARY_MATCH_WINDOW_MS))
      .lt(AssetField.CREATION_TIME, Math.ceil(center + LIBRARY_MATCH_WINDOW_MS))
      .limit(LIBRARY_MATCH_LIMIT)
      .exeForMetadata();
    return matchLibraryAsset(candidates, {
      fileName: asset.fileName,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      takenAt,
    });
  } catch (e) {
    log.debug(`picked photo not found in the library: ${errorMessage(e)}`);
    return null;
  }
}

/** Needs library read access; without it (or for a missing asset) we fall back to EXIF. */
async function libraryCreationTime(libraryId: string): Promise<number | null> {
  try {
    const ms = await new Asset(libraryId).getCreationTime();
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}
