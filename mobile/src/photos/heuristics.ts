/**
 * Cheap on-device filters applied before anything leaves the phone. Pure. OWNER: photos/scheduling builder.
 */
import type { PhotoAsset } from '../types';

/**
 * Reason to skip a photo without classifying it, or null to keep it:
 * `screenshot` (iOS mediaSubtypes / Android filename), `too_small` (< 400 px short edge),
 * `messaging_app` (filenames typical of WhatsApp/Telegram/Signal downloads), `screen_recording`.
 */
export function exclusionReason(asset: PhotoAsset): string | null {
  throw new Error('not implemented');
}
