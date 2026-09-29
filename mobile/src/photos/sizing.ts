/** Pure resize math for photos/images.ts. OWNER: photos/scheduling builder. */

/**
 * Resize argument that makes the longest edge at most `maxEdge` — and, when `maxPixels` is given,
 * the whole image at most that many pixels — while preserving the aspect ratio (only one
 * dimension is given, the manipulator derives the other), or null when the image already fits —
 * we never upscale.
 */
export function downscaleTarget(
  width: number,
  height: number,
  maxEdge: number,
  maxPixels?: number,
): { width: number } | { height: number } | null {
  const edge = Math.max(1, Math.round(maxEdge));
  if (!(width > 0) || !(height > 0)) return null;
  const longEdge = Math.max(width, height);
  let target = Math.min(longEdge, edge);
  if (maxPixels !== undefined && maxPixels > 0 && width * height > maxPixels) {
    // Floor, so the edge the manipulator derives can't round the area back over the cap.
    target = Math.min(target, Math.floor(longEdge * Math.sqrt(maxPixels / (width * height))));
  }
  if (target >= longEdge) return null;
  target = Math.max(1, target);
  return width >= height ? { width: target } : { height: target };
}

/** Base64 payload without a `data:image/…;base64,` prefix. */
export function stripDataUriPrefix(base64: string): string {
  return base64.replace(/^data:[^;,]*;base64,/, '');
}
