/** Camera / photo-library pickers for Quick log (expo-image-picker). */
import * as ImagePicker from 'expo-image-picker';
import { Asset } from 'expo-media-library';
import { Platform } from 'react-native';
import { exifCaptureTime, fallbackPickedId, libraryIdFromPicker, type PickedAssetLike } from './pickerMapping';

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
  const libraryId = libraryIdFromPicker(asset.assetId, Platform.OS, androidApi);
  const fromLibrary = libraryId ? await libraryCreationTime(libraryId) : null;
  const fromExif = fromLibrary ?? exifCaptureTime(asset.exif);
  return {
    assetId: libraryId ?? fallbackPickedId(asset),
    uri: asset.uri,
    creationTime: fromExif ?? Date.now(),
    timeGuessed: fromExif === null,
  };
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
