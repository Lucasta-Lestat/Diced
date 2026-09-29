/// <reference types="jest" />
import { toLocalDate } from '../../lib/dates';
import type { PhotoRecord } from '../../types';
import { groupMealPhotos, guessMealSlot, pickMealPhotos } from '../grouping';

// Local wall-clock times, so the tests hold in any time zone.
const at = (d: number, h: number, min = 0) => new Date(2026, 8, d, h, min).getTime();

function photo(id: string, time: number): PhotoRecord {
  return {
    assetId: id,
    uri: `ph://${id}`,
    creationTime: time,
    localDate: toLocalDate(time),
    origin: 'library',
    excludedReason: null,
    category: 'food',
    categoryConfidence: 0.9,
    classifiedAt: 1,
    processedAt: null,
    error: null,
  };
}

const ids = (groups: PhotoRecord[][]) => groups.map((g) => g.map((p) => p.assetId));

describe('groupMealPhotos', () => {
  it('chains photos less than the gap apart and sorts unsorted input', () => {
    const photos = [
      photo('dinner', at(28, 19, 0)),
      photo('lunch-2', at(28, 12, 15)),
      photo('lunch-1', at(28, 12, 0)),
      photo('lunch-3', at(28, 12, 34)),
    ];
    expect(ids(groupMealPhotos(photos, 20))).toEqual([['lunch-1', 'lunch-2', 'lunch-3'], ['dinner']]);
  });

  it('starts a new meal at exactly the gap', () => {
    const photos = [photo('a', at(28, 12, 0)), photo('b', at(28, 12, 20))];
    expect(ids(groupMealPhotos(photos, 20))).toEqual([['a'], ['b']]);
  });

  it('keeps a meal that crosses midnight together (the after photo is not a second meal)', () => {
    const photos = [photo('dinner', at(28, 23, 50)), photo('after', at(29, 0, 5)), photo('breakfast', at(29, 8, 0))];
    expect(ids(groupMealPhotos(photos, 20))).toEqual([['dinner', 'after'], ['breakfast']]);
  });

  it('orders simultaneous photos by asset id and handles empty input', () => {
    const t = at(28, 8, 0);
    expect(ids(groupMealPhotos([photo('b', t), photo('a', t)], 20))).toEqual([['a', 'b']]);
    expect(groupMealPhotos([], 20)).toEqual([]);
  });
});

describe('guessMealSlot', () => {
  it.each([
    [0, 0, 'snack'],
    [3, 59, 'snack'],
    [4, 0, 'breakfast'],
    [10, 29, 'breakfast'],
    [10, 30, 'lunch'],
    [14, 59, 'lunch'],
    [15, 0, 'snack'],
    [16, 59, 'snack'],
    [17, 0, 'dinner'],
    [21, 29, 'dinner'],
    [21, 30, 'snack'],
    [23, 59, 'snack'],
  ])('%i:%i → %s', (h, min, slot) => {
    expect(guessMealSlot(at(28, h, min))).toBe(slot);
  });
});

describe('pickMealPhotos', () => {
  it('keeps small groups whole', () => {
    expect(pickMealPhotos([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('keeps first and last and spaces the rest evenly', () => {
    expect(pickMealPhotos([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([0, 3, 6, 9]);
    expect(pickMealPhotos([0, 1, 2, 3, 4])).toEqual([0, 1, 3, 4]);
  });
});
