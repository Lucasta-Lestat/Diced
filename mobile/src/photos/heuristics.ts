/**
 * Cheap on-device filters applied before anything leaves the phone. Pure. OWNER: photos/scheduling builder.
 */
import type { PhotoAsset } from '../types';

export type ExclusionReason = 'screenshot' | 'screen_recording' | 'messaging_app' | 'too_small';

/** Photos whose shorter edge is below this are icons, stickers or thumbnails. */
export const MIN_SHORT_EDGE_PX = 400;

// Only prefixes that a camera never produces, so a match is a safe exclusion.
const SCREENSHOT_NAME =
  /^(screenshot|screen[\s_-]shot|bildschirmfoto|capture d['’\s]\S*cran|captura de pantalla|schermafbeelding|スクリーンショット)/i;

// Android recorders (Screen_Recording_…) and iOS ReplayKit (RPReplay_Final….mp4). Stills from
// these can land in the library via "save frame"; videos themselves are never listed.
const SCREEN_RECORDING_NAME = /^(screen[\s_-]?record(ing)?|screenrecord|rpreplay)/i;

const MESSAGING_NAMES: RegExp[] = [
  // WhatsApp (Android): IMG-20260928-WA0001.jpg, also stickers/voice/video variants.
  /^(img|vid|stk|ptt|aud|doc)-\d{8}-wa\d+/i,
  // Signal: signal-2026-09-28-101010.jpg, signal-2026-09-28-10-10-10-123.jpg
  /^signal-\d{4}-\d{2}-\d{2}/i,
  // Telegram: telegram-cloud-photo-size-….jpg and desktop exports photo_2026-09-28_10-10-10.jpg
  /^telegram[-_]/i,
  /^photo_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/i,
  // Facebook Messenger (Android): received_1234567890123456.jpeg
  /^received_\d{9,}\./i,
];

function hasSubtype(asset: PhotoAsset, subtype: string): boolean {
  return asset.mediaSubtypes.some((s) => s.toLowerCase() === subtype.toLowerCase());
}

function isTooSmall(asset: PhotoAsset): boolean {
  // Unknown dimensions (0) are not evidence of anything.
  if (!(asset.width > 0) || !(asset.height > 0)) return false;
  return Math.min(asset.width, asset.height) < MIN_SHORT_EDGE_PX;
}

/**
 * Reason to skip a photo without classifying it, or null to keep it:
 * `screenshot` (iOS mediaSubtypes / Android filename), `too_small` (< 400 px short edge),
 * `messaging_app` (filenames typical of WhatsApp/Telegram/Signal/Messenger downloads, or a
 * messaging app's album — see scanner.MESSAGING_ALBUMS), `screen_recording`.
 * Messaging-app detection is best-effort: an image saved from iMessage (or a chat app that saves
 * into no album of its own) has an ordinary camera-style name on iPhone and can't be told apart.
 * Photos taken in the app or picked by hand are always kept: the user chose them.
 */
export function exclusionReason(asset: PhotoAsset): ExclusionReason | null {
  if (asset.origin === 'capture' || asset.presetCategory) return null;
  const name = (asset.filename ?? '').trim();

  if (hasSubtype(asset, 'screenshot') || SCREENSHOT_NAME.test(name)) return 'screenshot';
  if (SCREEN_RECORDING_NAME.test(name)) return 'screen_recording';
  if (asset.fromMessagingAlbum || MESSAGING_NAMES.some((re) => re.test(name))) return 'messaging_app';
  if (isTooSmall(asset)) return 'too_small';
  return null;
}
