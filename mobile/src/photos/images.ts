/**
 * Image preparation (expo-image-manipulator). Re-encoding to JPEG strips EXIF, including
 * GPS, before anything is uploaded. OWNER: photos/scheduling builder.
 */
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import { downscaleTarget, stripDataUriPrefix } from './sizing';

export interface PreparedImage {
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}

export const THUMBNAIL_MAX_EDGE = 384;
const THUMBNAIL_QUALITY = 0.6;
/** Claude's vision input is downscaled beyond ~1568 px anyway; larger only costs upload time. */
export const MODEL_MAX_EDGE = 1568;
const MODEL_QUALITY = 0.8;

/** The manipulator always writes a file to the cache; we only need the bytes. */
function deleteQuietly(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A leftover cache file is harmless; the OS purges the cache directory.
  }
}

async function encodeJpeg(uri: string, maxEdge: number, compress: number): Promise<PreparedImage> {
  // The context loads the image once (fixing EXIF orientation on iOS); rendering first tells us
  // the real pixel size so we can skip the resize for images that are already small.
  const context = ImageManipulator.manipulate(uri);
  const rendered: ImageRef[] = [];
  try {
    const original = await context.renderAsync();
    rendered.push(original);
    const target = downscaleTarget(original.width, original.height, maxEdge);
    let image = original;
    if (target) {
      image = await context.resize(target).renderAsync();
      rendered.push(image);
    }
    const saved = await image.saveAsync({ base64: true, format: SaveFormat.JPEG, compress });
    deleteQuietly(saved.uri);
    if (!saved.base64) throw new Error('Image encoder returned no data');
    return {
      base64: stripDataUriPrefix(saved.base64),
      mediaType: 'image/jpeg',
      width: saved.width,
      height: saved.height,
    };
  } finally {
    // Full-size bitmaps are large; free them now rather than waiting for GC (matters in background runs).
    for (const ref of rendered) ref.release();
    context.release();
  }
}

/** Small thumbnail for classification: longest edge `maxEdge` (default 384), JPEG q≈0.6. */
export async function makeThumbnail(uri: string, maxEdge: number = THUMBNAIL_MAX_EDGE): Promise<PreparedImage> {
  return encodeJpeg(uri, maxEdge, THUMBNAIL_QUALITY);
}

/** Detail image for reading a scale / estimating food: longest edge ≤ 1568, JPEG q≈0.8. */
export async function prepareForModel(uri: string): Promise<PreparedImage> {
  return encodeJpeg(uri, MODEL_MAX_EDGE, MODEL_QUALITY);
}
