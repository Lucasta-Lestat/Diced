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
/**
 * Food photos. The model (Opus 5 tier) accepts up to 2576 px / ~3.75 MP per image (up to ~4784
 * image tokens), but a meal sends up to 4 photos (twice in thorough mode) and food portions don't
 * need display-level detail, so food photos stay at 1568 px (~2.5k tokens each) as a deliberate
 * cost / latency trade-off.
 */
export const MODEL_MAX_EDGE = 1568;
/**
 * Scale photos: one per day and precision-critical (seven-segment digits, a faint decimal point on
 * a display that is a small part of the frame), so they use the model's full resolution: 2576 px
 * on the long edge and no more than ~3.75 MP, so the API doesn't downscale them again.
 */
export const SCALE_MAX_EDGE = 2576;
export const SCALE_MAX_PIXELS = 3_750_000;
const MODEL_QUALITY = 0.8;

/**
 * Full-size decodes in flight across the whole app (classification thumbnails, scale reads, meal
 * estimates). The manipulator decodes the original at full size before resizing — about 100 MB
 * for a 24 MP photo, twice that on iOS with the orientation fix — so the pipeline's own
 * concurrency (2 classify batches × 4 thumbnails, 3 model calls) must not multiply that.
 */
export const DECODE_LIMIT = 2;
let decodesInFlight = 0;
const decodeQueue: (() => void)[] = [];

async function withDecodeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (decodesInFlight >= DECODE_LIMIT) {
    await new Promise<void>((resolve) => decodeQueue.push(resolve));
  } else {
    decodesInFlight++;
  }
  try {
    return await task();
  } finally {
    // Hand the slot straight to the next waiter (the count stays the same), or free it.
    const next = decodeQueue.shift();
    if (next) next();
    else decodesInFlight--;
  }
}

/** The manipulator always writes a file to the cache; we only need the bytes. */
function deleteQuietly(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A leftover cache file is harmless; the OS purges the cache directory.
  }
}

function encodeJpeg(uri: string, maxEdge: number, compress: number, maxPixels?: number): Promise<PreparedImage> {
  return withDecodeSlot(() => encodeJpegNow(uri, maxEdge, compress, maxPixels));
}

async function encodeJpegNow(uri: string, maxEdge: number, compress: number, maxPixels?: number): Promise<PreparedImage> {
  // The context loads the image once (fixing EXIF orientation on iOS); rendering first tells us
  // the real pixel size so we can skip the resize for images that are already small.
  const context = ImageManipulator.manipulate(uri);
  const rendered: ImageRef[] = [];
  try {
    const original = await context.renderAsync();
    rendered.push(original);
    const target = downscaleTarget(original.width, original.height, maxEdge, maxPixels);
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

/** Detail image for estimating food: longest edge ≤ 1568, JPEG q≈0.8. */
export async function prepareForModel(uri: string): Promise<PreparedImage> {
  return encodeJpeg(uri, MODEL_MAX_EDGE, MODEL_QUALITY);
}

/** Detail image for reading a scale display: longest edge ≤ 2576 and ≤ 3.75 MP, JPEG q≈0.8. */
export async function prepareScaleImage(uri: string): Promise<PreparedImage> {
  return encodeJpeg(uri, SCALE_MAX_EDGE, MODEL_QUALITY, SCALE_MAX_PIXELS);
}
