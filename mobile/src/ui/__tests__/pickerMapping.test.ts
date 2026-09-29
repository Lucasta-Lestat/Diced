/// <reference types="jest" />
import {
  exifCaptureTime,
  fallbackPickedId,
  libraryIdFromPicker,
  matchLibraryAsset,
  parseExifDateTime,
  type LibraryMetaLike,
} from '../pickerMapping';

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

describe('Android system photo picker (no MediaStore id)', () => {
  // The picker's content://media/picker/… URIs give assetId null.
  const takenAt = new Date(2026, 8, 28, 12, 15, 0).getTime();
  const lunch: LibraryMetaLike = {
    id: 'content://media/external/images/media/1234',
    filename: 'PXL_20260928_121500123.jpg',
    width: 4080,
    height: 3072,
    creationTime: takenAt + 123,
  };
  const other: LibraryMetaLike = { id: 'content://media/external/images/media/1200', filename: 'PXL_20260928_080000000.jpg', width: 4080, height: 3072, creationTime: takenAt - 4 * 3_600_000 };
  const picked = { fileName: 'PXL_20260928_121500123.jpg', width: 3072, height: 4080, takenAt };

  it('has no library id from the picker itself', () => {
    expect(libraryIdFromPicker(null, 'android', 34)).toBeNull();
    expect(fallbackPickedId({ uri: 'file:///cache/ImagePicker/x.jpg', fileName: picked.fileName })).toBe('picked:PXL_20260928_121500123.jpg');
  });

  it('finds the library entry by file name (so it dedupes with the scanner’s row)', () => {
    expect(matchLibraryAsset([other, lunch], picked)?.id).toBe(lunch.id);
    expect(matchLibraryAsset([other, lunch], { ...picked, fileName: 'pxl_20260928_121500123.JPG' })?.id).toBe(lunch.id);
  });

  it('breaks file-name ties on size, then on the closest capture time', () => {
    const sameNameOtherCamera: LibraryMetaLike = { ...lunch, id: 'content://media/external/images/media/77', width: 1600, height: 1200 };
    expect(matchLibraryAsset([sameNameOtherCamera, lunch], picked)?.id).toBe(lunch.id);
    const sameNameLater: LibraryMetaLike = { ...lunch, id: 'content://media/external/images/media/88', creationTime: takenAt + 30 * 3_600_000 };
    expect(matchLibraryAsset([sameNameLater, lunch], picked)?.id).toBe(lunch.id);
  });

  it('without a name match, accepts only one same-size photo taken the same second', () => {
    const renamed = { ...picked, fileName: '1000012345.jpg' };
    expect(matchLibraryAsset([other, lunch], renamed)?.id).toBe(lunch.id);
    const burst: LibraryMetaLike = { ...lunch, id: 'content://media/external/images/media/1235', filename: 'PXL_20260928_121500456.jpg', creationTime: takenAt + 456 };
    expect(matchLibraryAsset([lunch, burst], renamed)).toBeNull();
    expect(matchLibraryAsset([lunch], { ...renamed, takenAt: null })).toBeNull();
    expect(matchLibraryAsset([lunch], { ...renamed, width: 0, height: 0 })).toBeNull();
  });

  it('returns null when nothing matches (the photo keeps its picked: id)', () => {
    expect(matchLibraryAsset([], picked)).toBeNull();
    expect(matchLibraryAsset([other], picked)).toBeNull();
  });
});
