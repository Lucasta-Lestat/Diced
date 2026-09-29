/// <reference types="jest" />
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import {
  currentAppFileUri,
  displayUriFor,
  getPhotoPermission,
  listPhotosInRange,
  requestPhotoPermission,
  resolveReadableUri,
} from '../scanner';

interface FakeMeta {
  id: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  creationTime: number | null;
  mediaType: string;
}

interface FakeState {
  metadata: FakeMeta[];
  queries: { filters: [string, string, unknown][]; limit: number; offset: number; order: unknown; album: string | null }[];
  subtypes: Record<string, string[]>;
  uris: Record<string, string | Error>;
  subtypeCalls: number;
  /** Album title → asset ids in it. */
  albums: Record<string, string[]>;
}

const mockExistingFiles = new Set<string>();

jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
  }
  return {
    Directory,
    Paths: { document: new Directory('file:///var/mobile/Containers/Data/Application/NEW/Documents') },
    File: class {
      uri: string;
      constructor(...parts: unknown[]) {
        this.uri = join(parts);
      }
      get exists() {
        return mockExistingFiles.has(this.uri);
      }
    },
  };
});

jest.mock('expo-media-library', () => {
  const state: FakeState = { metadata: [], queries: [], subtypes: {}, uris: {}, subtypeCalls: 0, albums: {} };

  class Album {
    title: string;
    constructor(name: string) {
      this.title = name;
    }
    static async get(name: string) {
      return name in state.albums ? new Album(name) : null;
    }
  }

  class Query {
    private filters: [string, string, unknown][] = [];
    private lim = Number.POSITIVE_INFINITY;
    private off = 0;
    private order: unknown = null;
    private inAlbum: string | null = null;
    album(album: Album) {
      this.inAlbum = album.title;
      return this;
    }
    eq(field: string, value: unknown) {
      this.filters.push(['eq', field, value]);
      return this;
    }
    gte(field: string, value: number) {
      this.filters.push(['gte', field, value]);
      return this;
    }
    lt(field: string, value: number) {
      this.filters.push(['lt', field, value]);
      return this;
    }
    orderBy(order: unknown) {
      this.order = order;
      return this;
    }
    limit(n: number) {
      this.lim = n;
      return this;
    }
    offset(n: number) {
      this.off = n;
      return this;
    }
    async exeForMetadata() {
      state.queries.push({ filters: this.filters, limit: this.lim, offset: this.off, order: this.order, album: this.inAlbum });
      const albumIds = this.inAlbum === null ? null : state.albums[this.inAlbum];
      const matches = state.metadata.filter((m) =>
        (albumIds === null || albumIds.includes(m.id)) &&
        this.filters.every(([op, field, value]) => {
          const actual = (m as unknown as Record<string, unknown>)[field];
          if (op === 'eq') return actual === value;
          if (actual === null) return false;
          return op === 'gte' ? (actual as number) >= (value as number) : (actual as number) < (value as number);
        }),
      );
      matches.sort((a, b) => (a.creationTime ?? 0) - (b.creationTime ?? 0));
      return matches.slice(this.off, this.off + this.lim);
    }
  }

  class Asset {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
    async getMediaSubtypes() {
      state.subtypeCalls++;
      return state.subtypes[this.id] ?? [];
    }
    async getUri() {
      const uri = state.uris[this.id];
      if (uri instanceof Error) throw uri;
      if (uri === undefined) throw Object.assign(new Error(`Asset not found: ${this.id}`), { code: 'ERR_ASSET_NOT_FOUND' });
      return uri;
    }
  }

  return {
    Album,
    Query,
    Asset,
    AssetField: { CREATION_TIME: 'creationTime', MEDIA_TYPE: 'mediaType' },
    MediaType: { IMAGE: 'image', VIDEO: 'video' },
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    __state: state,
  };
});

const state = (MediaLibrary as unknown as { __state: FakeState }).__state;
const ML = jest.mocked(MediaLibrary);
const platform = Platform as { OS: string };
const originalOS = platform.OS;
const originalVersion = Object.getOwnPropertyDescriptor(Platform, 'Version');
// `Version` is a getter in react-native's Platform module, so it is redefined rather than assigned.
const setPlatformVersion = (version: number) =>
  Object.defineProperty(Platform, 'Version', { get: () => version, configurable: true });

function meta(i: number, patch: Partial<FakeMeta> = {}): FakeMeta {
  return {
    id: `ph://asset-${i}`,
    filename: `IMG_${i}.HEIC`,
    width: 3024,
    height: 4032,
    creationTime: 1_000_000 + i * 1000,
    mediaType: 'image',
    ...patch,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  state.metadata = [];
  state.queries = [];
  state.subtypes = {};
  state.uris = {};
  state.subtypeCalls = 0;
  state.albums = {};
  mockExistingFiles.clear();
  platform.OS = 'ios';
});

afterAll(() => {
  platform.OS = originalOS;
  if (originalVersion) Object.defineProperty(Platform, 'Version', originalVersion);
});

describe('photo permission', () => {
  it('asks for read-only photo access (no video/audio)', async () => {
    ML.requestPermissionsAsync.mockResolvedValue({
      status: 'granted',
      granted: true,
      accessPrivileges: 'limited',
    } as MediaLibrary.PermissionResponse);
    await expect(requestPhotoPermission()).resolves.toBe('granted_limited');
    expect(ML.requestPermissionsAsync).toHaveBeenCalledWith(false, ['photo']);
  });

  it('reads the current permission the same way', async () => {
    ML.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false } as MediaLibrary.PermissionResponse);
    await expect(getPhotoPermission()).resolves.toBe('undetermined');
    expect(ML.getPermissionsAsync).toHaveBeenCalledWith(false, ['photo']);
  });
});

describe('listPhotosInRange', () => {
  it('pages through every image in [start, end), oldest first', async () => {
    state.metadata = Array.from({ length: 1203 }, (_, i) => meta(i)).reverse();
    const start = meta(0).creationTime!;
    const end = meta(1203).creationTime!;

    const photos = await listPhotosInRange(start, end);

    expect(photos).toHaveLength(1203);
    expect(photos[0].id).toBe('ph://asset-0');
    expect(photos[1202].id).toBe('ph://asset-1202');
    expect(photos.every((p, i) => i === 0 || p.creationTime >= photos[i - 1].creationTime)).toBe(true);
    expect(state.queries.map((q) => q.offset)).toEqual([0, 500, 1000]);
    expect(state.queries[0].filters).toEqual([
      ['eq', 'mediaType', 'image'],
      ['gte', 'creationTime', start],
      ['lt', 'creationTime', end],
    ]);
    expect(state.queries[0].order).toEqual({ key: 'creationTime', ascending: true });
  });

  it('excludes the end bound and non-images', async () => {
    state.metadata = [meta(1), meta(2, { mediaType: 'video' }), meta(3)];
    const photos = await listPhotosInRange(meta(1).creationTime!, meta(3).creationTime!);
    expect(photos.map((p) => p.id)).toEqual(['ph://asset-1']);
  });

  it('maps assets and reads iOS media subtypes', async () => {
    state.metadata = [meta(1), meta(2, { filename: 'IMG_2.PNG' })];
    state.subtypes = { 'ph://asset-2': ['screenshot'] };
    const photos = await listPhotosInRange(0, Number.MAX_SAFE_INTEGER);
    expect(photos[1]).toEqual({
      id: 'ph://asset-2',
      uri: 'ph://asset-2',
      creationTime: meta(2).creationTime,
      width: 3024,
      height: 4032,
      filename: 'IMG_2.PNG',
      mediaSubtypes: ['screenshot'],
      origin: 'library',
    });
    expect(photos[0].mediaSubtypes).toEqual([]);
  });

  it('skips the per-asset subtype lookup on Android', async () => {
    platform.OS = 'android';
    state.metadata = [meta(1, { id: 'content://media/external/images/media/1', width: null, height: null })];
    const photos = await listPhotosInRange(0, Number.MAX_SAFE_INTEGER);
    expect(state.subtypeCalls).toBe(0);
    expect(photos[0]).toMatchObject({ uri: 'content://media/external/images/media/1', mediaSubtypes: [], width: 0 });
  });

  it('marks photos in a messaging app album (iOS saves them with camera-style names)', async () => {
    state.metadata = [meta(1), meta(2), meta(3)];
    state.albums = { WhatsApp: ['ph://asset-2', 'ph://outside-window'], Camera: ['ph://asset-1'] };
    const photos = await listPhotosInRange(meta(1).creationTime!, meta(4).creationTime!);
    expect(photos.map((p) => [p.id, p.fromMessagingAlbum ?? false])).toEqual([
      ['ph://asset-1', false],
      ['ph://asset-2', true],
      ['ph://asset-3', false],
    ]);
    // The album lookup is limited to the same window.
    const albumQuery = state.queries.find((q) => q.album === 'WhatsApp');
    expect(albumQuery?.filters).toContainEqual(['gte', 'creationTime', meta(1).creationTime]);
  });

  it('still lists photos when the album lookup fails', async () => {
    state.metadata = [meta(1)];
    const get = (MediaLibrary as unknown as { Album: { get: (t: string) => Promise<unknown> } }).Album;
    const spy = jest.spyOn(get, 'get').mockRejectedValue(new Error('no albums'));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const photos = await listPhotosInRange(0, Number.MAX_SAFE_INTEGER);
    expect(photos.map((p) => p.id)).toEqual(['ph://asset-1']);
    expect(photos[0].fromMessagingAlbum).toBeUndefined();
    spy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns nothing for an empty window without querying', async () => {
    await expect(listPhotosInRange(5, 5)).resolves.toEqual([]);
    expect(state.queries).toHaveLength(0);
  });
});

describe('resolveReadableUri', () => {
  it('returns the local file for an iOS asset (downloaded from iCloud if needed)', async () => {
    state.uris = { 'ph://asset-1': 'file:///var/mobile/Media/DCIM/100APPLE/IMG_1.HEIC' };
    await expect(resolveReadableUri('ph://asset-1', 'ph://asset-1')).resolves.toBe(
      'file:///var/mobile/Media/DCIM/100APPLE/IMG_1.HEIC',
    );
  });

  it('returns null when the asset was deleted', async () => {
    await expect(resolveReadableUri('ph://gone', 'ph://gone')).resolves.toBeNull();
  });

  it('rethrows transient failures so the photo is retried', async () => {
    state.uris = { 'ph://asset-1': Object.assign(new Error('network lost'), { code: 'ERR_FAILED_TO_EXTRACT_URI' }) };
    await expect(resolveReadableUri('ph://asset-1', 'ph://asset-1')).rejects.toThrow('network lost');
  });

  it('checks quick-log captures on disk instead of the library', async () => {
    mockExistingFiles.add('file:///data/diced/captures/a.jpg');
    await expect(resolveReadableUri('capture:a', 'file:///data/diced/captures/a.jpg')).resolves.toBe(
      'file:///data/diced/captures/a.jpg',
    );
    await expect(resolveReadableUri('capture:b', 'file:///data/diced/captures/b.jpg')).resolves.toBeNull();
  });

  it('finds a capture again after iOS moved the app container (app update / reinstall)', async () => {
    const old = 'file:///var/mobile/Containers/Data/Application/OLD/Documents/captures/a.jpg';
    const now = 'file:///var/mobile/Containers/Data/Application/NEW/Documents/captures/a.jpg';
    mockExistingFiles.add(now);
    await expect(resolveReadableUri('capture:a', old)).resolves.toBe(now);
    expect(currentAppFileUri(old)).toBe(now);
    // Only the app's own folders are relocated.
    expect(currentAppFileUri('file:///var/mobile/Containers/Data/Application/OLD/Library/Caches/ImagePicker/a.jpg')).toBeNull();
  });

  it("falls back to the library asset when a picked photo's cached copy was purged", async () => {
    state.uris = { 'ph://asset-7': 'file:///var/mobile/Media/DCIM/100APPLE/IMG_7.HEIC' };
    const purged = 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/7.jpg';
    await expect(resolveReadableUri('ph://asset-7', purged)).resolves.toBe('file:///var/mobile/Media/DCIM/100APPLE/IMG_7.HEIC');
    // Still there: the copy is used (works with limited library access).
    mockExistingFiles.add(purged);
    await expect(resolveReadableUri('ph://asset-7', purged)).resolves.toBe(purged);
    // A pick without a library id has nothing to fall back to.
    await expect(resolveReadableUri('picked:IMG_9.jpg', 'file:///cache/ImagePicker/9.jpg')).resolves.toBeNull();
    // Deleted from the library too.
    await expect(resolveReadableUri('ph://asset-8', 'file:///cache/ImagePicker/8.jpg')).resolves.toBeNull();
  });

  it('uses the file path on Android 11+ and the content URI on Android 10', async () => {
    const id = 'content://media/external/images/media/42';
    state.uris = { [id]: 'file:///storage/emulated/0/DCIM/Camera/PXL_1.jpg' };
    platform.OS = 'android';
    setPlatformVersion(35);
    await expect(resolveReadableUri(id, id)).resolves.toBe('file:///storage/emulated/0/DCIM/Camera/PXL_1.jpg');
    setPlatformVersion(29);
    await expect(resolveReadableUri(id, id)).resolves.toBe(id);
  });
});

describe('displayUriFor', () => {
  it('shows library assets directly and follows moved or purged files', () => {
    expect(displayUriFor({ assetId: 'ph://a', uri: 'ph://a' })).toBe('ph://a');
    const kept = 'file:///var/mobile/Containers/Data/Application/NEW/Documents/captures/c.jpg';
    mockExistingFiles.add(kept);
    expect(displayUriFor({ assetId: 'capture:c', uri: kept })).toBe(kept);
    expect(displayUriFor({ assetId: 'capture:c', uri: 'file:///var/mobile/Containers/Data/Application/OLD/Documents/captures/c.jpg' })).toBe(kept);
    // Picker cache copy purged → the library id (expo-image loads ph:// and content:// itself).
    expect(displayUriFor({ assetId: 'content://media/external/images/media/5', uri: 'file:///data/cache/ImagePicker/5.jpg' })).toBe(
      'content://media/external/images/media/5',
    );
    expect(displayUriFor({ assetId: 'picked:x.jpg', uri: 'file:///data/cache/ImagePicker/x.jpg' })).toBe('file:///data/cache/ImagePicker/x.jpg');
  });
});
