/// <reference types="jest" />
import type { PhotoAsset } from '../../types';
import { createLock, mapLimit } from '../concurrency';
import { hasPresetCategory, modelConfidence, nextLastScanEnd, photoRecordFromAsset, presetPhotoRecord } from '../records';

const at = (d: number, h: number) => new Date(2026, 8, d, h).getTime();

function asset(patch: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    id: 'a1',
    uri: 'ph://a1',
    creationTime: at(27, 23),
    width: 3024,
    height: 4032,
    filename: 'IMG_0001.HEIC',
    mediaSubtypes: [],
    origin: 'library',
    ...patch,
  };
}

describe('photo records', () => {
  it('maps a scanned asset with its local date and exclusion', () => {
    expect(photoRecordFromAsset(asset(), 5)).toEqual({
      assetId: 'a1',
      uri: 'ph://a1',
      creationTime: at(27, 23),
      localDate: '2026-09-27',
      origin: 'library',
      excludedReason: null,
      category: null,
      categoryConfidence: null,
      classifiedAt: null,
      processedAt: null,
      error: null,
    });
    expect(photoRecordFromAsset(asset({ mediaSubtypes: ['screenshot'] }), 5).excludedReason).toBe('screenshot');
  });

  it('marks user-chosen categories so manual mode can tell them apart', () => {
    const preset = photoRecordFromAsset(asset({ presetCategory: 'food' }), 5);
    expect(preset).toMatchObject({ category: 'food', categoryConfidence: 1, classifiedAt: 5 });
    expect(hasPresetCategory(preset)).toBe(true);
    const picked = presetPhotoRecord({ assetId: 'p', uri: 'ph://p', creationTime: at(27, 8), origin: 'library' }, 'scale', 9);
    expect(hasPresetCategory(picked)).toBe(true);
    expect(hasPresetCategory({ ...picked, categoryConfidence: modelConfidence(1) })).toBe(false);
    expect(hasPresetCategory({ ...picked, origin: 'capture', categoryConfidence: 0.5 })).toBe(true);
  });

  it('caps model confidences below the preset marker', () => {
    expect([modelConfidence(1), modelConfidence(0.7), modelConfidence(-1), modelConfidence(Number.NaN)]).toEqual([0.99, 0.7, 0, 0]);
  });
});

describe('nextLastScanEnd', () => {
  const window = { startMs: 100, endMs: 200 };

  it('advances after a default window, even across a gap', () => {
    expect(nextLastScanEnd(null, window, false)).toBe(200);
    expect(nextLastScanEnd(50, window, false)).toBe(200);
  });

  it('never moves backwards', () => {
    expect(nextLastScanEnd(300, window, false)).toBeNull();
    expect(nextLastScanEnd(200, window, true)).toBeNull();
  });

  it('only advances after an explicit window that continues the last scan', () => {
    expect(nextLastScanEnd(150, window, true)).toBe(200);
    expect(nextLastScanEnd(50, window, true)).toBeNull();
    expect(nextLastScanEnd(null, window, true)).toBe(200);
  });
});

describe('mapLimit', () => {
  it('limits concurrency and stops starting items when asked', async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    const started = await mapLimit(
      [1, 2, 3, 4, 5, 6],
      2,
      async (n) => {
        running++;
        peak = Math.max(peak, running);
        seen.push(n);
        await new Promise((r) => setTimeout(r, 1));
        running--;
      },
      () => seen.length >= 3,
    );
    expect(peak).toBe(2);
    expect(started).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('rethrows the first error after the workers stop', async () => {
    const done: number[] = [];
    await expect(
      mapLimit([1, 2, 3], 1, async (n) => {
        if (n === 2) throw new Error('two');
        done.push(n);
      }),
    ).rejects.toThrow('two');
    expect(done).toEqual([1]);
    expect(await mapLimit([], 3, async () => undefined)).toBe(0);
  });
});

describe('createLock', () => {
  it('runs tasks one at a time in order, even after a failure', async () => {
    const lock = createLock();
    const log: string[] = [];
    const task = (name: string, fail = false) =>
      lock(async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 1));
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task('a'), task('b', true), task('c')]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
