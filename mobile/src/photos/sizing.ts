/** Pure resize math for photos/images.ts. OWNER: photos/scheduling builder. */

/**
 * Resize argument that makes the longest edge `maxEdge` while preserving the aspect ratio
 * (only one dimension is given, the manipulator derives the other), or null when the image
 * already fits — we never upscale.
 */
export function downscaleTarget(
  width: number,
  height: number,
  maxEdge: number,
): { width: number } | { height: number } | null {
  const edge = Math.max(1, Math.round(maxEdge));
  if (!(width > 0) || !(height > 0)) return null;
  if (Math.max(width, height) <= edge) return null;
  return width >= height ? { width: edge } : { height: edge };
}

/** Base64 payload without a `data:image/…;base64,` prefix. */
export function stripDataUriPrefix(base64: string): string {
  return base64.replace(/^data:[^;,]*;base64,/, '');
}
