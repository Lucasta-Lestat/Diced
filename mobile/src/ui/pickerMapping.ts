/**
 * Pure mapping from expo-image-picker results to what the pipeline expects (no native
 * imports so Jest can cover it).
 */
import { PICKED_ID_PREFIX } from '../photos/appFiles';

/** The subset of ImagePickerAsset we rely on. */
export interface PickedAssetLike {
  uri: string;
  assetId?: string | null;
  fileName?: string | null;
  /** 0 when the system didn't report it. */
  width?: number;
  height?: number;
  exif?: Record<string, unknown> | null;
}

/**
 * The picker reports a bare PHAsset localIdentifier (iOS) or a MediaStore row id (Android);
 * expo-media-library's object API (what the scanner stores) uses `ph://<id>` and the
 * MediaStore content URI. Matching ids lets a hand-picked photo dedupe with a scanned one.
 */
export function libraryIdFromPicker(pickerAssetId: string | null | undefined, os: string, androidApi: number): string | null {
  const id = pickerAssetId?.trim();
  if (!id) return null;
  if (os === 'ios') return id.startsWith('ph://') ? id : `ph://${id}`;
  if (os === 'android') {
    if (id.startsWith('content://')) return id;
    if (!/^\d+$/.test(id)) return null;
    // Android 10 (API 29) lists images under the primary external volume's own name.
    const volume = androidApi === 29 ? 'external_primary' : 'external';
    return `content://media/${volume}/images/media/${id}`;
  }
  return null;
}

/** EXIF `2026:09:28 07:42:10` (camera-local wall clock) → ms, or null. */
export function parseExifDateTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Capture time from EXIF (original, then digitized, then plain DateTime). */
export function exifCaptureTime(exif: Record<string, unknown> | null | undefined): number | null {
  if (!exif) return null;
  for (const key of ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime']) {
    const ms = parseExifDateTime(exif[key]);
    if (ms !== null) return ms;
  }
  return null;
}

/** Stable id for a picked photo the media library can't identify (e.g. a file browser pick). */
export function fallbackPickedId(asset: PickedAssetLike): string {
  // pipeline/process.ts matches `picked:<file name>` against later scans (photos/appFiles.ts).
  return `${PICKED_ID_PREFIX}${asset.fileName?.trim() || asset.uri}`;
}

/** The subset of expo-media-library's AssetMetadata used to find a picked photo in the library. */
export interface LibraryMetaLike {
  id: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  creationTime: number | null;
}

/**
 * How far either side of a picked photo's capture time to look for its library entry. EXIF times are
 * camera wall-clock, so this also covers a photo taken in another time zone.
 */
export const LIBRARY_MATCH_WINDOW_MS = 36 * 60 * 60_000;
/** EXIF times have whole seconds; the library keeps milliseconds. */
const SAME_MOMENT_MS = 1_500;

function sameSize(meta: LibraryMetaLike, width: number, height: number): boolean {
  if (!(width > 0 && height > 0) || !meta.width || !meta.height) return false;
  // The library may report the stored (unrotated) size.
  return (meta.width === width && meta.height === height) || (meta.width === height && meta.height === width);
}

function distance(meta: LibraryMetaLike, takenAt: number | null): number {
  if (takenAt === null || meta.creationTime === null) return Number.POSITIVE_INFINITY;
  return Math.abs(meta.creationTime - takenAt);
}

/**
 * The media-library entry for a photo picked with Android's system photo picker, which reports no
 * MediaStore id (its `content://media/picker/…` URIs aren't MediaStore document URIs). Using the
 * library's id lets the photo dedupe with the scanner's row for the same image, so it isn't
 * estimated as a second meal.
 *
 * Matches on file name; size and then the closest capture time break ties (two cameras can both
 * write IMG_0001.jpg). Without a name match, only one entry with the same size taken at the same
 * second counts — anything ambiguous returns null (the photo keeps a `picked:` id).
 */
export function matchLibraryAsset(
  candidates: readonly LibraryMetaLike[],
  picked: { fileName: string | null | undefined; width: number; height: number; takenAt: number | null },
): LibraryMetaLike | null {
  const byTime = (a: LibraryMetaLike, b: LibraryMetaLike) => distance(a, picked.takenAt) - distance(b, picked.takenAt);
  const name = picked.fileName?.trim().toLowerCase();
  if (name) {
    const named = candidates.filter((m) => m.filename?.trim().toLowerCase() === name);
    const sized = named.filter((m) => sameSize(m, picked.width, picked.height));
    const pool = sized.length ? sized : named;
    if (pool.length) return [...pool].sort(byTime)[0];
  }
  if (picked.takenAt === null) return null;
  const sameMoment = candidates.filter((m) => sameSize(m, picked.width, picked.height) && distance(m, picked.takenAt) <= SAME_MOMENT_MS);
  return sameMoment.length === 1 ? sameMoment[0] : null;
}
