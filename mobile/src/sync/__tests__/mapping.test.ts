/// <reference types="jest" />
import type { FoodItem, LibraryItem, MealEntry, MealEstimate, WeightEntry } from '../../types';
import type { SheetLibraryItem } from '../contract';
import {
  flagLabel,
  formatItem,
  libraryIdFromName,
  libraryItemFromRow,
  libraryItemToRow,
  MAX_NOTES_CHARS,
  mealEntryToRow,
  slotToSheetMeal,
  truncate,
  weightEntryToRow,
} from '../mapping';

function weight(patch: Partial<WeightEntry> = {}): WeightEntry {
  return {
    id: 'w:Her:2026-09-28',
    person: 'Her',
    localDate: '2026-09-28',
    time: '06:45',
    valueLb: 184.64,
    chosenAssetId: 'a1',
    source: 'photo',
    confidence: 'high',
    candidates: [],
    flags: [],
    notes: '',
    status: 'approved',
    syncError: null,
    updatedAt: 1,
    ...patch,
  };
}

function item(patch: Partial<FoodItem> = {}): FoodItem {
  return {
    name: 'chicken breast',
    portion: '1 fillet',
    grams: 150,
    macros: { kcal: 247.6, proteinG: 46.5, carbsG: 0, fatG: 5.4 },
    source: 'usda',
    confidence: 'medium',
    usdaQuery: 'chicken breast cooked',
    fdcId: 1,
    modelMacros: null,
    ...patch,
  };
}

function estimate(patch: Partial<MealEstimate> = {}): MealEstimate {
  return {
    title: 'Chicken rice bowl',
    items: [item(), item({ name: 'white rice', grams: 180.4, macros: { kcal: 234.2, proteinG: 4, carbsG: 51, fatG: 0.5 } })],
    totals: { kcal: 482, proteinG: 50, carbsG: 51, fatG: 6 },
    kcalLow: 420,
    kcalHigh: 560,
    confidence: 'medium',
    method: 'photo',
    questions: [
      { id: 'q1', question: 'How much oil was used?', options: ['None', '1 tsp', '1 tbsp'], affects: ['chicken breast'] },
      { id: 'q2', question: 'Dressing?', options: ['None', 'Some'], affects: [] },
    ],
    assumptions: ['cooked in 1 tsp olive oil', 'rice is plain', 'no sauce', 'fourth assumption'],
    libraryItemId: null,
    brand: null,
    barcode: null,
    model: 'claude-opus-5-5',
    samples: 1,
    createdAt: 1,
    ...patch,
  };
}

function meal(patch: Partial<MealEntry> = {}): MealEntry {
  return {
    id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    person: 'Him',
    localDate: '2026-09-29',
    time: '12:30',
    slot: 'lunch',
    assetIds: ['a'],
    estimate: estimate(),
    final: { kcal: 512.4, proteinG: 50.5, carbsG: 51.49, fatG: 9.6 },
    title: ' Chicken bowl ',
    answers: { q1: '1 tbsp' },
    notes: 'Extra hot sauce',
    status: 'approved',
    error: null,
    updatedAt: 1,
    ...patch,
  };
}

describe('weightEntryToRow', () => {
  it('maps a reading with 1-decimal weight', () => {
    expect(weightEntryToRow(weight())).toEqual({
      entryId: 'w:Her:2026-09-28',
      date: '2026-09-28',
      time: '06:45',
      person: 'Her',
      weightLb: 184.6,
      source: 'photo',
      confidence: 'high',
      notes: '',
    });
  });

  it('uses an empty time for manual entries and appends readable flags to notes', () => {
    const row = weightEntryToRow(
      weight({ time: null, source: 'manual', notes: 'after run', flags: ['unit_converted', 'odd_new_flag'] }),
    );
    expect(row.time).toBe('');
    expect(row.source).toBe('manual');
    expect(row.notes).toBe('after run · Flags: converted from kg, odd new flag');
  });

  it('notes are just the flags when there is no user note', () => {
    expect(weightEntryToRow(weight({ flags: ['not_morning', 'not_morning'] })).notes).toBe(
      'Flags: not a morning weigh-in',
    );
  });

  it('throws without a value', () => {
    expect(() => weightEntryToRow(weight({ valueLb: null }))).toThrow('has no value');
  });
});

describe('mealEntryToRow', () => {
  it('maps totals (rounded), slot, method, confidence, items and notes', () => {
    const row = mealEntryToRow(meal());
    expect(row).toEqual({
      entryId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      date: '2026-09-29',
      time: '12:30',
      person: 'Him',
      meal: 'Lunch',
      description: 'Chicken bowl',
      kcal: 512,
      proteinG: 51,
      carbsG: 51,
      fatG: 10,
      confidence: 'medium',
      method: 'photo',
      items: 'chicken breast 150 g (248 kcal) · white rice 180 g (234 kcal)',
      notes:
        'Extra hot sauce · How much oil was used: 1 tbsp · ' +
        'Assumed: cooked in 1 tsp olive oil; rice is plain; no sauce',
    });
  });

  it('uses the portion when grams are unknown', () => {
    expect(formatItem(item({ name: 'protein bar', grams: null, portion: '1 bar', macros: { kcal: 210, proteinG: 20, carbsG: 22, fatG: 7 } }))).toBe(
      'protein bar 1 bar (210 kcal)',
    );
    expect(formatItem(item({ name: 'apple', grams: null, portion: ' ' }))).toBe('apple (248 kcal)');
  });

  it('manual meals (no estimate): method manual, medium confidence, no items', () => {
    const row = mealEntryToRow(meal({ estimate: null, answers: { q1: 'x' }, notes: '', title: 'Toast', slot: 'breakfast' }));
    expect(row).toMatchObject({ method: 'manual', confidence: 'medium', items: '', notes: '', meal: 'Breakfast', description: 'Toast' });
  });

  it('falls back to the estimate title, then the slot, for the description', () => {
    expect(mealEntryToRow(meal({ title: '  ' })).description).toBe('Chicken rice bowl');
    expect(mealEntryToRow(meal({ title: '', estimate: null, slot: 'snack' })).description).toBe('Snack');
  });

  it('skips blank answers and answers to unknown questions; caps notes at 500 chars', () => {
    const row = mealEntryToRow(meal({ answers: { q1: ' ', gone: 'x', q2: 'Some' }, notes: '' }));
    expect(row.notes.startsWith('Dressing: Some · Assumed:')).toBe(true);

    const long = mealEntryToRow(meal({ notes: 'x'.repeat(600) }));
    expect(long.notes).toHaveLength(MAX_NOTES_CHARS);
    expect(long.notes.endsWith('…')).toBe(true);
  });

  it('writes check_portion flags as readable text, never the raw token', () => {
    const row = mealEntryToRow(
      meal({
        notes: '',
        answers: {},
        estimate: estimate({ assumptions: ['check_portion:white rice', ' check_portion: white rice', 'check_portion:', 'rice is plain'] }),
      }),
    );
    expect(row.notes).toBe('Assumed: check portion of white rice; rice is plain');
    expect(row.notes).not.toContain('check_portion');
  });

  it('uses the estimate method (e.g. label, library)', () => {
    expect(mealEntryToRow(meal({ estimate: estimate({ method: 'label', confidence: 'high' }) }))).toMatchObject({
      method: 'label',
      confidence: 'high',
    });
  });
});

describe('slotToSheetMeal', () => {
  it('capitalises every slot', () => {
    expect(['breakfast', 'lunch', 'dinner', 'snack'].map((s) => slotToSheetMeal(s as never))).toEqual([
      'Breakfast',
      'Lunch',
      'Dinner',
      'Snack',
    ]);
  });
});

describe('library mapping', () => {
  const lib: LibraryItem = {
    id: 'lib-1',
    name: 'Overnight oats',
    serving: '1 jar',
    macros: { kcal: 410.4, proteinG: 22.5, carbsG: 55, fatG: 11.2 },
    aliases: ['oats', ' oats ', 'ONO'],
    addedBy: 'Her',
    uses: 4,
    updatedAt: Date.UTC(2026, 8, 28, 7, 30),
    synced: false,
  };

  it('to row: rounded macros, ISO updatedAt, deduped aliases', () => {
    expect(libraryItemToRow(lib)).toEqual({
      entryId: 'lib-1',
      name: 'Overnight oats',
      serving: '1 jar',
      kcal: 410,
      proteinG: 23,
      carbsG: 55,
      fatG: 11,
      aliases: ['oats', 'ONO'],
      addedBy: 'Her',
      uses: 4,
      updatedAt: '2026-09-28T07:30:00.000Z',
    });
  });

  it('round-trips through the sheet as synced', () => {
    const back = libraryItemFromRow(libraryItemToRow(lib));
    expect(back).toEqual({
      ...lib,
      macros: { kcal: 410, proteinG: 23, carbsG: 55, fatG: 11 },
      aliases: ['oats', 'ONO'],
      synced: true,
    });
  });

  it('tolerates hand-typed rows (string numbers, comma aliases, blank id / date)', () => {
    const row = {
      entryId: '',
      name: ' Chili  con carne ',
      serving: '1 bowl',
      kcal: '1,050' as unknown as number,
      proteinG: '' as unknown as number,
      carbsG: 40,
      fatG: 'n/a' as unknown as number,
      aliases: 'chili, con carne,' as unknown as string[],
      addedBy: 'Him',
      uses: '' as unknown as number,
      updatedAt: '',
    } satisfies SheetLibraryItem;
    expect(libraryItemFromRow(row)).toEqual({
      id: libraryIdFromName('Chili  con carne'),
      name: 'Chili  con carne',
      serving: '1 bowl',
      macros: { kcal: 1050, proteinG: 0, carbsG: 40, fatG: 0 },
      aliases: ['chili', 'con carne'],
      addedBy: 'Him',
      uses: 0,
      updatedAt: 0,
      synced: true,
    });
    expect(libraryIdFromName('Chili  con carne')).toBe('name:chili con carne');
  });
});

describe('helpers', () => {
  it('flagLabel and truncate', () => {
    expect(flagLabel('differs_from_trend')).toBe('differs from recent trend');
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 5)).toBe('abcd…');
  });
});
