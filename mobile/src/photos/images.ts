/**
 * Image preparation (expo-image-manipulator). Re-encoding to JPEG strips EXIF, including
 * GPS, before anything is uploaded. OWNER: photos/scheduling builder.
 */

export interface PreparedImage {
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}

/** Small thumbnail for classification: longest edge `maxEdge` (default 384), JPEG q≈0.6. */
export async function makeThumbnail(uri: string, maxEdge?: number): Promise<PreparedImage> {
  throw new Error('not implemented');
}

/** Detail image for reading a scale / estimating food: longest edge ≤ 1568, JPEG q≈0.8. */
export async function prepareForModel(uri: string): Promise<PreparedImage> {
  throw new Error('not implemented');
}
