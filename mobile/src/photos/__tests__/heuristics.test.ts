/// <reference types="jest" />
import type { PhotoAsset } from '../../types';
import { exclusionReason } from '../heuristics';

function photo(patch: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    id: 'ph://A1',
    uri: 'ph://A1',
    creationTime: 0,
    width: 3024,
    height: 4032,
    filename: 'IMG_1234.HEIC',
    mediaSubtypes: [],
    origin: 'library',
    ...patch,
  };
}

describe('exclusionReason', () => {
  it.each([
    'IMG_1234.HEIC',
    'IMG_20260928_071512.jpg',
    'PXL_20260928_071512345.jpg',
    '20260928_071512.jpg',
    'DSC_0042.JPG',
    'IMG-20260928-001.jpg', // not a WhatsApp name (no -WA)
    'signalflare.jpg',
    'photo.jpg',
    'received.jpg',
  ])('keeps ordinary camera photo %s', (filename) => {
    expect(exclusionReason(photo({ filename }))).toBeNull();
  });

  it('keeps photos without a filename or dimensions', () => {
    expect(exclusionReason(photo({ filename: null, width: 0, height: 0 }))).toBeNull();
  });

  it('flags iOS screenshots by media subtype', () => {
    expect(exclusionReason(photo({ filename: 'IMG_0001.PNG', mediaSubtypes: ['screenshot'] }))).toBe('screenshot');
  });

  it('ignores unrelated iOS subtypes', () => {
    expect(exclusionReason(photo({ mediaSubtypes: ['livePhoto', 'hdr', 'depthEffect'] }))).toBeNull();
  });

  it.each([
    'Screenshot_20260928-101010.png',
    'Screenshot_20260928-101010_WhatsApp.jpg',
    'screenshot-2026-09-28.png',
    'Screen Shot 2026-09-28 at 10.10.10.png',
    'Screenshot 2026-09-28 at 10.10.10.png',
    'Bildschirmfoto 2026-09-28 um 10.10.10.png',
  ])('flags screenshot filename %s', (filename) => {
    expect(exclusionReason(photo({ filename }))).toBe('screenshot');
  });

  it.each(['Screen_Recording_20260928-101010_Chrome.jpg', 'screenrecord-frame.jpg', 'RPReplay_Final1727512345.jpg'])(
    'flags screen recording %s',
    (filename) => {
      expect(exclusionReason(photo({ filename }))).toBe('screen_recording');
    },
  );

  it.each([
    'IMG-20260928-WA0001.jpg',
    'img-20260928-wa0123.jpeg',
    'STK-20260928-WA0002.webp',
    'signal-2026-09-28-101010.jpg',
    'signal-2026-09-28-10-10-10-123.jpg',
    'telegram-cloud-photo-size-2-5199-y.jpg',
    'photo_2026-09-28_10-10-10.jpg',
    'received_1234567890123456.jpeg',
  ])('flags messaging-app download %s', (filename) => {
    expect(exclusionReason(photo({ filename }))).toBe('messaging_app');
  });

  it('flags images whose short edge is below 400 px', () => {
    expect(exclusionReason(photo({ width: 399, height: 1200 }))).toBe('too_small');
    expect(exclusionReason(photo({ width: 400, height: 400 }))).toBeNull();
  });

  it('never excludes in-app captures or hand-picked photos', () => {
    const screenshotLike = { filename: 'Screenshot_20260928.png', mediaSubtypes: ['screenshot'], width: 100, height: 100 };
    expect(exclusionReason(photo({ ...screenshotLike, origin: 'capture' }))).toBeNull();
    expect(exclusionReason(photo({ ...screenshotLike, presetCategory: 'nutrition_label' }))).toBeNull();
  });
});
