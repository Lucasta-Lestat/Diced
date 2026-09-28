/// <reference types="jest" />
import { exifCaptureTime, fallbackPickedId, libraryIdFromPicker, parseExifDateTime } from '../pickerMapping';

describe('libraryIdFromPicker', () => {
  it('prefixes iOS local identifiers with ph://', () => {
    expect(libraryIdFromPicker('C166F9F5-B5FE-4501-9531/L0/001', 'ios', 0)).toBe('ph://C166F9F5-B5FE-4501-9531/L0/001');
    expect(libraryIdFromPicker('ph://ABC', 'ios', 0)).toBe('ph://ABC');
  });

  it('builds Android MediaStore content URIs', () => {
    expect(libraryIdFromPicker('1234', 'android', 34)).toBe('content://media/external/images/media/1234');
    expect(libraryIdFromPicker('1234', 'android', 29)).toBe('content://media/external_primary/images/media/1234');
    expect(libraryIdFromPicker('content://media/external/images/media/9', 'android', 34)).toBe('content://media/external/images/media/9');
    expect(libraryIdFromPicker('msf:12', 'android', 34)).toBeNull();
  });

  it('returns null without an id', () => {
    expect(libraryIdFromPicker(null, 'ios', 0)).toBeNull();
    expect(libraryIdFromPicker('  ', 'android', 34)).toBeNull();
    expect(libraryIdFromPicker('1', 'web', 0)).toBeNull();
  });
});

describe('EXIF capture time', () => {
  it('parses EXIF timestamps as local wall-clock time', () => {
    expect(parseExifDateTime('2026:09:28 07:42:10')).toBe(new Date(2026, 8, 28, 7, 42, 10).getTime());
    expect(parseExifDateTime('2026:09:28 07:42')).toBe(new Date(2026, 8, 28, 7, 42, 0).getTime());
    expect(parseExifDateTime('2026:13:28 07:42:10')).toBeNull();
    expect(parseExifDateTime('yesterday')).toBeNull();
    expect(parseExifDateTime(42)).toBeNull();
  });

  it('prefers DateTimeOriginal', () => {
    expect(
      exifCaptureTime({ DateTime: '2026:09:29 10:00:00', DateTimeOriginal: '2026:09:28 07:00:00' }),
    ).toBe(new Date(2026, 8, 28, 7, 0, 0).getTime());
    expect(exifCaptureTime({ DateTime: '2026:09:29 10:00:00' })).toBe(new Date(2026, 8, 29, 10, 0, 0).getTime());
    expect(exifCaptureTime(null)).toBeNull();
  });
});

describe('fallbackPickedId', () => {
  it('uses the file name when there is one', () => {
    expect(fallbackPickedId({ uri: 'file:///cache/x.jpg', fileName: 'IMG_1.HEIC' })).toBe('picked:IMG_1.HEIC');
    expect(fallbackPickedId({ uri: 'file:///cache/x.jpg' })).toBe('picked:file:///cache/x.jpg');
  });
});
