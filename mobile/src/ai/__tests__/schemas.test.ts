/// <reference types="jest" />
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  ClassifySchema,
  cleanBarcode,
  FoodSchema,
  type FoodRaw,
  pickChoice,
  saneRange,
  ScaleSchema,
  type ScaleRaw,
  sumItemMacros,
  toClassifyResults,
  toMealEstimate,
  toPublishedNutrition,
  toScaleReading,
} from '../schemas';

const UNSUPPORTED_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'pattern'];

function collectKeys(node: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => collectKeys(n, found));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      if (key === 'minItems' && value !== 0 && value !== 1) found.add('minItems>1');
      collectKeys(value, found);
    }
  }
  return found;
}

describe('structured-output schemas', () => {
  it.each([
    ['classify', ClassifySchema],
    ['scale', ScaleSchema],
    ['food', FoodSchema],
  ])('%s schema stays within supported JSON Schema', (_name, schema) => {
    const keys = collectKeys(betaZodOutputFormat(schema).schema, new Set());
    for (const bad of [...UNSUPPORTED_KEYS, 'minItems>1']) expect(keys.has(bad)).toBe(false);
  });

  it('keeps field descriptions (the model relies on them)', () => {
    const schema = betaZodOutputFormat(ScaleSchema).schema as { properties: Record<string, { description?: string }> };
    expect(schema.properties.value.description).toMatch(/Null unless/);
    expect(schema.properties.unit.description).toMatch(/"kg"/);
  });
});

describe('pickChoice', () => {
  it('normalises case, spaces and dashes', () => {
    expect(pickChoice('Nutrition label', ['scale', 'nutrition_label'] as const, 'scale')).toBe('nutrition_label');
    expect(pickChoice(' HIGH ', ['high', 'low'] as const, 'low')).toBe('high');
  });
  it('falls back on unknown values', () => {
    expect(pickChoice('banana', ['a', 'b'] as const, 'b')).toBe('b');
    expect(pickChoice(null, ['a'] as const, 'a')).toBe('a');
  });
});

describe('toClassifyResults', () => {
  it('maps photo numbers to asset ids, clamps confidence, fills missing ids', () => {
    const out = toClassifyResults(
      {
        photos: [
          { photo: 1, category: 'scale', confidence: 0.97 },
          { photo: 2, category: 'Food', confidence: 1.4 },
          { photo: 2, category: 'other', confidence: 0.2 }, // duplicate: first wins
          { photo: 9, category: 'food', confidence: 0.9 }, // out of range
          { photo: 4, category: 'selfie', confidence: -1 },
        ],
      },
      ['a', 'b', 'c', 'd'],
    );
    expect(out).toEqual({
      a: { category: 'scale', confidence: 0.97 },
      b: { category: 'food', confidence: 1 },
      c: { category: 'other', confidence: 0 },
      d: { category: 'other', confidence: 0 },
    });
  });
});

const scaleRaw = (over: Partial<ScaleRaw> = {}): ScaleRaw => ({
  is_scale: true,
  display_text: '172.4 lb',
  reading_kind: 'body_weight',
  value: 172.4,
  unit: 'lb',
  stone_pounds: null,
  confidence: 'high',
  issues: [],
  ...over,
});

describe('toScaleReading', () => {
  it('passes through a clean reading', () => {
    expect(toScaleReading(scaleRaw(), 'lb')).toEqual({ isScale: true, value: 172.4, unit: 'lb', confidence: 'high', issues: [] });
  });

  it('assumes the configured unit when none is visible', () => {
    const r = toScaleReading(scaleRaw({ unit: 'unknown', value: 78.2 }), 'kg');
    expect(r).toMatchObject({ value: 78.2, unit: 'kg', confidence: 'high' });
  });

  it('notes a unit that differs from settings', () => {
    const r = toScaleReading(scaleRaw({ unit: 'kg', value: 78.2 }), 'lb');
    expect(r.unit).toBe('kg');
    expect(r.issues).toContain('display shows kg (settings say lb)');
  });

  it('converts stones and pounds to lb', () => {
    const r = toScaleReading(scaleRaw({ unit: 'st', value: 12, stone_pounds: 4.6 }), 'lb');
    expect(r).toMatchObject({ value: 172.6, unit: 'lb' });
    expect(r.issues).toContain('converted from stones');
  });

  it('never returns a value for other metrics or unreadable displays', () => {
    const fat = toScaleReading(scaleRaw({ reading_kind: 'other_metric', value: 24.1, unit: 'unknown' }), 'lb');
    expect(fat).toMatchObject({ isScale: true, value: null, unit: null, confidence: 'low' });
    expect(fat.issues[0]).toMatch(/another metric/);
    const blur = toScaleReading(scaleRaw({ value: null, confidence: 'low', issues: ['motion blur'] }), 'lb');
    expect(blur).toMatchObject({ value: null, issues: ['motion blur'] });
  });

  it('flags implausible values', () => {
    const r = toScaleReading(scaleRaw({ value: 1724 }), 'lb');
    expect(r.confidence).toBe('low');
    expect(r.issues).toContain('value outside the plausible body-weight range');
  });

  it('reports non-scale photos', () => {
    expect(toScaleReading(scaleRaw({ is_scale: false }), 'lb')).toEqual({
      isScale: false,
      value: null,
      unit: null,
      confidence: 'low',
      issues: [],
    });
  });
});

const item = (over: Partial<FoodRaw['items'][number]> = {}): FoodRaw['items'][number] => ({
  name: 'chicken breast',
  portion: '1 breast',
  grams: 150.4,
  kcal: 247.6,
  protein_g: 46.44,
  carbs_g: 0,
  fat_g: 5.4,
  basis: 'estimate',
  confidence: 'medium',
  usda_query: 'chicken breast, roasted, meat only',
  ...over,
});

const foodRaw = (over: Partial<FoodRaw> = {}): FoodRaw => ({
  contains_food: true,
  title: 'Chicken and rice',
  method: 'photo',
  items: [item(), item({ name: 'white rice', grams: 180, kcal: 234, protein_g: 4.9, carbs_g: 50.8, fat_g: 0.5, usda_query: 'rice, white, long-grain, cooked' })],
  kcal_low: 520,
  kcal_high: 400, // deliberately below the total
  confidence: 'medium',
  questions: [],
  assumptions: ['Cooked without oil', 'cooked without oil', ' '],
  library_item_id: null,
  brand: null,
  barcode: null,
  ...over,
});

const ctx = { model: 'claude-opus-5-5', libraryIds: ['lib-1'], now: 1_000 };

describe('toMealEstimate', () => {
  it('recomputes totals from items and repairs the range', () => {
    const est = toMealEstimate(foodRaw(), ctx);
    expect(est.totals).toEqual({ kcal: 482, proteinG: 51.3, carbsG: 50.8, fatG: 5.9 });
    expect(est.kcalLow).toBeLessThanOrEqual(est.totals.kcal);
    expect(est.kcalHigh).toBeGreaterThanOrEqual(est.totals.kcal);
    expect(est.kcalLow).toBe(400);
    expect(est.kcalHigh).toBe(520);
    expect(est.items[0]).toMatchObject({ grams: 150, source: 'model', fdcId: null, usdaQuery: 'chicken breast, roasted, meat only' });
    expect(est.items[0].modelMacros).toEqual(est.items[0].macros);
    expect(est.assumptions).toEqual(['Cooked without oil']);
    expect(est).toMatchObject({ samples: 1, model: 'claude-opus-5-5', createdAt: 1_000, method: 'photo', libraryItemId: null });
  });

  it('keeps only questions worth > 10 % of the total, max 3, with 2-4 options and ids q1..qN', () => {
    const q = (question: string, swing: number, options = ['None', '1 tsp', '1 tbsp']) => ({
      question,
      options,
      affects: ['chicken breast'],
      kcal_swing: swing,
    });
    const est = toMealEstimate(
      foodRaw({
        questions: [
          q('Oil?', 240),
          q('Salt?', 5), // too small
          q('One option?', 200, ['Yes']), // too few options
          q('Sauce?', 150, ['None', 'Light', 'Regular', 'Heavy', 'Extra']),
          q('Whole portion?', 120),
          q('Fourth?', 300),
        ],
      }),
      ctx,
    );
    expect(est.questions.map((x) => [x.id, x.question])).toEqual([
      ['q1', 'Oil?'],
      ['q2', 'Sauce?'],
      ['q3', 'Whole portion?'],
    ]);
    expect(est.questions[1].options).toHaveLength(4);
  });

  it('guards library ids, cleans barcodes and brands, maps label items', () => {
    const est = toMealEstimate(
      foodRaw({
        method: 'library',
        library_item_id: 'invented-id',
        brand: 'none',
        barcode: '0 12345-67890 5',
        items: [item({ basis: 'label', usda_query: 'granola bar' })],
      }),
      ctx,
    );
    expect(est.libraryItemId).toBeNull();
    expect(est.method).toBe('photo');
    expect(est.brand).toBeNull();
    expect(est.barcode).toBe('012345678905');
    expect(est.items[0]).toMatchObject({ source: 'label', usdaQuery: null });

    const matched = toMealEstimate(foodRaw({ method: 'library', library_item_id: 'lib-1', brand: ' Chipotle ' }), ctx);
    expect(matched).toMatchObject({ libraryItemId: 'lib-1', method: 'library', brand: 'Chipotle' });
  });

  it('returns an empty low-confidence estimate when there is no food', () => {
    const est = toMealEstimate(foodRaw({ contains_food: false, assumptions: [] }), ctx);
    expect(est.items).toEqual([]);
    expect(est.totals.kcal).toBe(0);
    expect(est.confidence).toBe('low');
    expect(est.assumptions[0]).toMatch(/No food/);
  });

  it('clamps negative and non-finite numbers', () => {
    const est = toMealEstimate(foodRaw({ items: [item({ kcal: -20, grams: -1, fat_g: Number.NaN })] }), ctx);
    expect(est.items[0].macros.kcal).toBe(0);
    expect(est.items[0].grams).toBeNull();
    expect(est.items[0].macros.fatG).toBe(0);
  });
});

describe('small helpers', () => {
  it('saneRange orders and brackets the total', () => {
    expect(saneRange(700, 300, 500)).toEqual({ kcalLow: 300, kcalHigh: 700 });
    expect(saneRange(Number.NaN, Number.NaN, 500)).toEqual({ kcalLow: 500, kcalHigh: 500 });
    expect(saneRange(-50, 10, 5)).toEqual({ kcalLow: 0, kcalHigh: 10 });
  });

  it('sumItemMacros rounds kcal to units and grams to 0.1', () => {
    const m = (kcal: number, p: number) => ({ macros: { kcal, proteinG: p, carbsG: 0, fatG: 0 } });
    expect(sumItemMacros([m(100.4, 1.04), m(50.4, 2.03)])).toEqual({ kcal: 151, proteinG: 3.1, carbsG: 0, fatG: 0 });
  });

  it('cleanBarcode accepts GTIN lengths only', () => {
    expect(cleanBarcode('5000112637922')).toBe('5000112637922');
    expect(cleanBarcode('12345')).toBeNull();
    expect(cleanBarcode(null)).toBeNull();
  });
});

describe('toPublishedNutrition', () => {
  const report = {
    found: true,
    source_url: 'https://www.chipotle.com/nutrition-calculator',
    item_name: 'Chicken Burrito Bowl',
    kcal: 655.4,
    protein_g: 52,
    carbs_g: null,
    fat_g: 24.44,
    serving_note: '1 bowl, regular',
  };

  it('converts a found report', () => {
    expect(toPublishedNutrition(report, 'burrito bowl')).toEqual({
      source: 'https://www.chipotle.com/nutrition-calculator',
      itemName: 'Chicken Burrito Bowl',
      macros: { kcal: 655, proteinG: 52, carbsG: 0, fatG: 24.4 },
      servingNote: '1 bowl, regular',
    });
  });

  it('returns null when not found, without numbers, without a URL, or malformed', () => {
    expect(toPublishedNutrition({ ...report, found: false }, 'x')).toBeNull();
    expect(toPublishedNutrition({ ...report, kcal: null }, 'x')).toBeNull();
    expect(toPublishedNutrition({ ...report, source_url: 'chipotle.com' }, 'x')).toBeNull();
    expect(toPublishedNutrition({ found: true }, 'x')).toBeNull();
  });
});
