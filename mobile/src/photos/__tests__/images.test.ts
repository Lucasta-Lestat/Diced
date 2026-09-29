/// <reference types="jest" />
import { ImageManipulator } from 'expo-image-manipulator';
import { DECODE_LIMIT, makeThumbnail, prepareForModel, prepareScaleImage } from '../images';

interface FakeImage {
  width: number;
  height: number;
  saveAsync: jest.Mock;
  release: jest.Mock;
}

interface FakeContext {
  resize: jest.Mock;
  renderAsync: jest.Mock;
  release: jest.Mock;
}

const mockDeleted: string[] = [];
const mockSources = new Map<string, { width: number; height: number }>();
const mockContexts: FakeContext[] = [];

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return true;
    }
    delete() {
      mockDeleted.push(this.uri);
    }
  },
}));

jest.mock('expo-image-manipulator', () => {
  const image = (width: number, height: number) => ({
    width,
    height,
    release: jest.fn(),
    saveAsync: jest.fn(async (options: { base64?: boolean; format?: string; compress?: number }) => ({
      uri: `file:///cache/ImageManipulator/${width}x${height}.jpg`,
      width,
      height,
      base64: options.base64 ? `b64-${width}x${height}-${options.format}-${options.compress}` : undefined,
    })),
  });

  return {
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    ImageManipulator: {
      manipulate: jest.fn((uri: string) => {
        const source = mockSources.get(uri);
        if (!source) throw new Error(`cannot load ${uri}`);
        let current = { ...source };
        const context: FakeContext = {
          resize: jest.fn((size: { width?: number; height?: number }): FakeContext => {
            const ratio = current.width / current.height;
            current =
              size.width !== undefined
                ? { width: size.width, height: Math.floor(size.width / ratio) }
                : { width: Math.floor(size.height! * ratio), height: size.height! };
            return context;
          }),
          renderAsync: jest.fn(async () => image(current.width, current.height)),
          release: jest.fn(),
        };
        mockContexts.push(context);
        return context;
      }),
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleted.length = 0;
  mockContexts.length = 0;
  mockSources.clear();
});

describe('makeThumbnail', () => {
  it('downscales the longest edge to 384 px as JPEG q0.6', async () => {
    mockSources.set('ph://A', { width: 3024, height: 4032 });
    const out = await makeThumbnail('ph://A');
    expect(mockContexts[0].resize).toHaveBeenCalledWith({ height: 384 });
    expect(out).toEqual({ base64: 'b64-288x384-jpeg-0.6', mediaType: 'image/jpeg', width: 288, height: 384 });
  });

  it('never upscales a small image', async () => {
    mockSources.set('file:///small.jpg', { width: 320, height: 240 });
    const out = await makeThumbnail('file:///small.jpg');
    expect(mockContexts[0].resize).not.toHaveBeenCalled();
    expect(out).toMatchObject({ width: 320, height: 240 });
  });

  it('honours a custom edge', async () => {
    mockSources.set('ph://B', { width: 4000, height: 3000 });
    const out = await makeThumbnail('ph://B', 512);
    expect(mockContexts[0].resize).toHaveBeenCalledWith({ width: 512 });
    expect(out).toMatchObject({ width: 512, height: 384 });
  });

  it('deletes the temporary file and frees native images', async () => {
    mockSources.set('ph://A', { width: 3024, height: 4032 });
    await makeThumbnail('ph://A');
    expect(mockDeleted).toEqual(['file:///cache/ImageManipulator/288x384.jpg']);
    expect(mockContexts[0].release).toHaveBeenCalled();
    for (const result of mockContexts[0].renderAsync.mock.results) {
      expect((await result.value as FakeImage).release).toHaveBeenCalled();
    }
  });
});

describe('prepareForModel', () => {
  it('caps the longest edge at 1568 px as JPEG q0.8', async () => {
    mockSources.set('file:///IMG_1.HEIC', { width: 4032, height: 3024 });
    const out = await prepareForModel('file:///IMG_1.HEIC');
    expect(mockContexts[0].resize).toHaveBeenCalledWith({ width: 1568 });
    expect(out).toEqual({ base64: 'b64-1568x1176-jpeg-0.8', mediaType: 'image/jpeg', width: 1568, height: 1176 });
  });

  it('re-encodes (strips EXIF) even when no resize is needed', async () => {
    mockSources.set('file:///label.jpg', { width: 1200, height: 900 });
    const out = await prepareForModel('file:///label.jpg');
    expect(mockContexts[0].resize).not.toHaveBeenCalled();
    expect(out.base64).toBe('b64-1200x900-jpeg-0.8');
  });

  it('releases the context when loading fails', async () => {
    jest.mocked(ImageManipulator.manipulate).mockImplementationOnce(() => {
      const context = {
        resize: jest.fn(),
        renderAsync: jest.fn(async () => {
          throw new Error('cannot decode');
        }),
        release: jest.fn(),
      };
      mockContexts.push(context);
      return context as never;
    });
    await expect(prepareForModel('file:///broken.jpg')).rejects.toThrow('cannot decode');
    expect(mockContexts[0].release).toHaveBeenCalled();
  });
});

describe('prepareScaleImage', () => {
  it("uses the model's full resolution for scale displays, capped at ~3.75 MP", async () => {
    mockSources.set('ph://scale', { width: 4032, height: 3024 });
    const out = await prepareScaleImage('ph://scale');
    expect(mockContexts[0].resize).toHaveBeenCalledWith({ width: 2236 });
    expect(out.width * out.height).toBeLessThanOrEqual(3_750_000);
    expect(out.base64).toBe('b64-2236x1677-jpeg-0.8');
  });

  it('keeps a scale photo that already fits (more detail than a food photo)', async () => {
    mockSources.set('file:///scale.jpg', { width: 2000, height: 1500 });
    const out = await prepareScaleImage('file:///scale.jpg');
    expect(mockContexts[0].resize).not.toHaveBeenCalled();
    expect(out).toMatchObject({ width: 2000, height: 1500 });
  });
});

describe('full-size decodes', () => {
  it(`never has more than ${DECODE_LIMIT} images decoding at once, across callers`, async () => {
    let open = 0;
    let maxOpen = 0;
    const real = jest.mocked(ImageManipulator.manipulate).getMockImplementation()!;
    jest.mocked(ImageManipulator.manipulate).mockImplementation((uri) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      const context = real(uri) as unknown as FakeContext;
      const render = context.renderAsync.getMockImplementation()!;
      context.renderAsync.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 2));
        return render();
      });
      context.release.mockImplementation(() => {
        open--;
      });
      return context as never;
    });
    for (let i = 0; i < 8; i++) mockSources.set(`ph://${i}`, { width: 4032, height: 3024 });

    const outs = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => makeThumbnail(`ph://${i}`)),
      prepareForModel('ph://6'),
      prepareScaleImage('ph://7'),
    ]);

    expect(outs).toHaveLength(8);
    expect(maxOpen).toBe(DECODE_LIMIT);
    expect(open).toBe(0);
  });

  it('frees the slot when a decode fails', async () => {
    jest.mocked(ImageManipulator.manipulate).mockImplementationOnce(() => {
      throw new Error('cannot load');
    });
    mockSources.set('ph://ok', { width: 100, height: 100 });
    await expect(makeThumbnail('ph://bad')).rejects.toThrow('cannot load');
    await expect(Promise.all(Array.from({ length: DECODE_LIMIT + 1 }, () => makeThumbnail('ph://ok')))).resolves.toHaveLength(DECODE_LIMIT + 1);
  });
});
