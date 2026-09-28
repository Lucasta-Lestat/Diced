/**
 * Pure mapping from expo-image-picker results to what the pipeline expects (no native
 * imports so Jest can cover it).
 */

/** The subset of ImagePickerAsset we rely on. */
export interface PickedAssetLike {
  uri: string;
  assetId?: string | null;
  fileName?: string | null;
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
  return `picked:${asset.fileName?.trim() || asset.uri}`;
}
