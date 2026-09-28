/// <reference types="jest" />
import type { LibraryItem } from '../../types';
import { libraryCandidates } from '../library';

function item(id: string, name: string, uses: number, aliases: string[] = [], updatedAt = 1): LibraryItem {
  return {
    id,
    name,
    serving: '1 bowl',
    macros: { kcal: 500, proteinG: 30, carbsG: 50, fatG: 15 },
    aliases,
    addedBy: 'Her',
    uses,
    updatedAt,
    synced: true,
  };
}

const LIBRARY = [
  item('oats', 'Overnight oats', 12),
  item('bowl', 'Chicken burrito bowl', 3, ['Chipotle bowl']),
  item('shake', 'Protein shake', 20),
  item('salad', 'Greek salad', 1),
  item('toast', 'Avocado toast', 7),
];

describe('libraryCandidates', () => {
  it('lists the most used items first without a hint', () => {
    expect(libraryCandidates(LIBRARY, '').map((i) => i.id)).toEqual(['shake', 'oats', 'toast', 'bowl', 'salad']);
  });

  it('puts items sharing a word with the hint (name or alias) first', () => {
    expect(libraryCandidates(LIBRARY, 'the usual Chipotle, extra salads', 3).map((i) => i.id)).toEqual([
      'bowl',
      'salad',
      'shake',
    ]);
  });

  it('matches plural/singular and ignores stop words', () => {
    expect(libraryCandidates(LIBRARY, 'with the toasts', 1).map((i) => i.id)).toEqual(['toast']);
  });

  it('respects the limit, defaults to 30 and drops duplicate ids', () => {
    const many = Array.from({ length: 40 }, (_, i) => item(`i${i}`, `Meal ${i}`, i));
    expect(libraryCandidates(many, '')).toHaveLength(30);
    expect(libraryCandidates(many, '', 0)).toEqual([]);
    expect(libraryCandidates([LIBRARY[0], LIBRARY[0]], '')).toHaveLength(1);
  });

  it('breaks use ties by most recently updated', () => {
    const a = item('a', 'A', 2, [], 10);
    const b = item('b', 'B', 2, [], 20);
    expect(libraryCandidates([a, b], '').map((i) => i.id)).toEqual(['b', 'a']);
  });
});
