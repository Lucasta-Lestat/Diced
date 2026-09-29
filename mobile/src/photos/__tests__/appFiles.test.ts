import { appFileParts, isLibraryAssetId, SAME_PHOTO_TOLERANCE_MS, withoutPickedDuplicates } from '../appFiles';

describe('appFiles', () => {
  it('tells library ids from our own ids', () => {
    expect(isLibraryAssetId('ph://ABC/L0/001')).toBe(true);
    expect(isLibraryAssetId('content://media/external/images/media/12')).toBe(true);
    expect(isLibraryAssetId('picked:IMG_1.jpg')).toBe(false);
    expect(isLibraryAssetId('capture:1')).toBe(false);
  });

  it('finds the folder and name of an app file', () => {
    expect(appFileParts('file:///var/app/Documents/captures/x.jpg')).toEqual({ dir: 'captures', name: 'x.jpg' });
    expect(appFileParts('file:///cache/ImagePicker/x.jpg')).toBeNull();
  });
});

describe('withoutPickedDuplicates', () => {
  const T = 1_790_000_000_000;
  const asset = (filename: string | null, creationTime: number) => ({ filename, creationTime });

  it('drops a scanned photo already hand-picked under picked:<file name> (same name, ≤2 s apart)', () => {
    const assets = [asset('IMG_1.jpg', T + 1500), asset('img_2.JPG', T - SAME_PHOTO_TOLERANCE_MS), asset('IMG_3.jpg', T)];
    const picked = [
      { assetId: 'picked:IMG_1.jpg', creationTime: T },
      { assetId: 'picked: IMG_2.jpg ', creationTime: T },
    ];
    expect(withoutPickedDuplicates(assets, picked)).toEqual([asset('IMG_3.jpg', T)]);
  });

  it('keeps photos with the same name taken at another time, unnamed photos, and non-picked ids', () => {
    const assets = [asset('IMG_1.jpg', T + SAME_PHOTO_TOLERANCE_MS + 1), asset(null, T), asset('IMG_9.jpg', T)];
    const picked = [
      { assetId: 'picked:IMG_1.jpg', creationTime: T },
      { assetId: 'content://media/9', creationTime: T },
      { assetId: 'picked:', creationTime: T },
    ];
    expect(withoutPickedDuplicates(assets, picked)).toEqual(assets);
    expect(withoutPickedDuplicates(assets, [])).toEqual(assets);
  });
});
