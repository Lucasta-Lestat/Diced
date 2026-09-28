/// <reference types="jest" />
import type { PhotoAsset } from '../../types';
import { isMissingAssetError, normalizeRange, toPhotoAsset, toPhotoPermission } from '../assetMapping';
import { downscaleTarget, stripDataUriPrefix } from '../sizing';

describe('toPhotoPermission', () => {
  it('maps full access', () => {
    expect(toPhotoPermission({ status: 'granted', granted: true, accessPrivileges: 'all' })).toBe('granted_all');
    // Older platforms may omit accessPrivileges.
    expect(toPhotoPermission({ status: 'granted', granted: true })).toBe('granted_all');
  });

  it('maps limited access (iOS limited / Android 14 selected photos)', () => {
    expect(toPhotoPermission({ status: 'granted', granted: true, accessPrivileges: 'limited' })).toBe('granted_limited');
  });

  it('maps undetermined and denied', () => {
    expect(toPhotoPermission({ status: 'undetermined', granted: false, accessPrivileges: 'none' })).toBe('undetermined');
    expect(toPhotoPermission({ status: 'denied', granted: false, accessPrivileges: 'none' })).toBe('denied');
  });
});

describe('toPhotoAsset', () => {
  it('maps metadata to a library PhotoAsset', () => {
    expect(
      toPhotoAsset(
        { id: 'ph://ABC/L0/001', filename: 'IMG_1.HEIC', width: 3024, height: 4032, creationTime: 1234 },
        ['livePhoto'],
      ),
    ).toEqual({
      id: 'ph://ABC/L0/001',
      uri: 'ph://ABC/L0/001',
      creationTime: 1234,
      width: 3024,
      height: 4032,
      filename: 'IMG_1.HEIC',
      mediaSubtypes: ['livePhoto'],
      origin: 'library',
    });
  });

  it('fills unknown Android dimensions with 0', () => {
    const asset = toPhotoAsset({
      id: 'content://media/external/images/media/7',
      filename: null,
      width: null,
      height: null,
      creationTime: 5,
    });
    expect(asset).toMatchObject({ width: 0, height: 0, filename: null, mediaSubtypes: [] });
  });
});

describe('normalizeRange', () => {
  const a = (id: string, creationTime: number) => ({ id, creationTime }) as PhotoAsset;

  it('keeps [start, end), drops duplicates and sorts oldest first', () => {
    const out = normalizeRange([a('c', 30), a('x', 9), a('a', 10), a('b', 30), a('a', 10), a('y', 40)], 10, 40);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('isMissingAssetError', () => {
  it('recognises not-found errors from either platform', () => {
    expect(isMissingAssetError({ code: 'ERR_ASSET_NOT_FOUND', message: 'Asset not found: ph://X' })).toBe(true);
    expect(isMissingAssetError({ code: 'ERR_ASSET_PROPERTY_NOT_FOUND', message: 'Uri not found.' })).toBe(true);
    expect(isMissingAssetError(new Error('Asset not found: content://media/external/images/media/9'))).toBe(true);
  });

  it('treats other failures (e.g. iCloud download) as transient', () => {
    expect(isMissingAssetError({ code: 'ERR_FAILED_TO_EXTRACT_URI', message: 'Missing content editing input' })).toBe(false);
    expect(isMissingAssetError(new Error('The network connection was lost.'))).toBe(false);
    expect(isMissingAssetError(null)).toBe(false);
  });
});

describe('downscaleTarget', () => {
  it('never upscales', () => {
    expect(downscaleTarget(300, 200, 384)).toBeNull();
    expect(downscaleTarget(384, 384, 384)).toBeNull();
  });

  it('constrains the longest edge and lets the other follow the aspect ratio', () => {
    expect(downscaleTarget(4032, 3024, 1568)).toEqual({ width: 1568 });
    expect(downscaleTarget(3024, 4032, 384)).toEqual({ height: 384 });
    expect(downscaleTarget(2000, 2000, 384)).toEqual({ width: 384 });
  });

  it('does nothing for unknown sizes', () => {
    expect(downscaleTarget(0, 0, 384)).toBeNull();
  });
});

describe('stripDataUriPrefix', () => {
  it('removes a data URI prefix and leaves raw base64 alone', () => {
    expect(stripDataUriPrefix('data:image/jpeg;base64,/9j/4AAQ')).toBe('/9j/4AAQ');
    expect(stripDataUriPrefix('/9j/4AAQ')).toBe('/9j/4AAQ');
  });
});
