/**
 * Photos the app keeps in its own storage (quick-log captures, copies of hand-picked files that
 * have no media-library id), and how ids tell library assets apart. Pure — no native imports.
 * OWNER: photos/scheduling builder.
 */

/** Folders under Paths.document. Stored URIs are absolute; see scanner.currentAppFileUri. */
export const CAPTURE_DIR = 'captures';
export const PICKED_DIR = 'picked';

const APP_FILE_PATTERN = new RegExp(`/(${CAPTURE_DIR}|${PICKED_DIR})/([^/]+)$`);

/** Media-library ids (`ph://…`, `content://…`), as opposed to our own `capture:` / `picked:` ids. */
export function isLibraryAssetId(assetId: string): boolean {
  return assetId.startsWith('ph://') || assetId.startsWith('content://');
}

/** `{ dir, name }` of a stored app-file URI (`…/captures/<name>`), or null for any other URI. */
export function appFileParts(uri: string): { dir: string; name: string } | null {
  const match = APP_FILE_PATTERN.exec(uri);
  return match ? { dir: match[1], name: match[2] } : null;
}

/** Id prefix of a hand-picked photo the media library couldn't identify (`picked:<file name>`). */
export const PICKED_ID_PREFIX = 'picked:';

/** The picker's and the media library's capture times for one photo may differ slightly. */
export const SAME_PHOTO_TOLERANCE_MS = 2000;

/**
 * Scanned library photos minus those already hand-picked under a `picked:<file name>` id (the
 * Android system photo picker gives no library id): same file name, ignoring case, and a capture
 * time within SAME_PHOTO_TOLERANCE_MS. Processing such a photo again would log the meal or
 * weigh-in a second time.
 */
export function withoutPickedDuplicates<T extends { filename: string | null; creationTime: number }>(
  assets: readonly T[],
  picked: readonly { assetId: string; creationTime: number }[],
): T[] {
  const pickedByName = new Map<string, number[]>();
  for (const p of picked) {
    if (!p.assetId.startsWith(PICKED_ID_PREFIX)) continue;
    const name = p.assetId.slice(PICKED_ID_PREFIX.length).trim().toLowerCase();
    if (!name) continue;
    pickedByName.set(name, [...(pickedByName.get(name) ?? []), p.creationTime]);
  }
  if (pickedByName.size === 0) return [...assets];
  return assets.filter((a) => {
    const times = a.filename ? pickedByName.get(a.filename.trim().toLowerCase()) : undefined;
    return !times?.some((t) => Math.abs(t - a.creationTime) <= SAME_PHOTO_TOLERANCE_MS);
  });
}
