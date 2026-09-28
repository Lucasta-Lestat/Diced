/// <reference types="jest" />
import type { FoodItem, MealEstimate } from '../../types';
import { mergeSamples } from '../merge';

const foodItem = (name: string, grams: number, kcal: number): FoodItem => ({
  name,
  portion: '',
  grams,
  macros: { kcal, proteinG: kcal / 20, carbsG: kcal / 10, fatG: kcal / 40 },
  source: 'model',
  confidence: 'medium',
  usdaQuery: name,
  fdcId: null,
  modelMacros: { kcal, proteinG: kcal / 20, carbsG: kcal / 10, fatG: kcal / 40 },
});

const estimate = (over: Partial<MealEstimate> & { kcal: number }): MealEstimate => {
  const { kcal, ...rest } = over;
  return {
    title: 'Pasta',
    items: [foodItem('pasta', 200, kcal * 0.75), foodItem('sauce', 100, kcal * 0.25)],
    totals: { kcal, proteinG: kcal / 20, carbsG: kcal / 10, fatG: kcal / 40 },
    kcalLow: Math.round(kcal * 0.8),
    kcalHigh: Math.round(kcal * 1.2),
    confidence: 'medium',
    method: 'photo',
    questions: [],
    assumptions: ['Regular portion'],
    libraryItemId: null,
    brand: null,
    barcode: null,
    model: 'claude-opus-5-5',
    samples: 1,
    createdAt: 1,
    ...rest,
  };
};

describe('mergeSamples', () => {
  it('averages totals, unions the range and keeps confidence when samples agree', () => {
    const merged = mergeSamples([estimate({ kcal: 600 }), estimate({ kcal: 660, confidence: 'high' })]);
    expect(merged.samples).toBe(2);
    expect(merged.totals).toEqual({ kcal: 630, proteinG: 31.5, carbsG: 63, fatG: 15.8 });
    expect(merged.kcalLow).toBe(480);
    expect(merged.kcalHigh).toBe(792);
    expect(merged.confidence).toBe('medium'); // the lower of the two; 10 % apart is agreement
    expect(merged.assumptions).toContain('Average of 2 independent estimates (600 / 660 kcal).');
  });

  it('uses the higher-confidence sample on the (two-sample) tie and scales its items to the mean', () => {
    const merged = mergeSamples([estimate({ kcal: 600, title: 'A' }), estimate({ kcal: 680, confidence: 'high', title: 'B' })]);
    expect(merged.title).toBe('B');
    expect(merged.totals.kcal).toBe(640);
    const itemKcal = merged.items.reduce((sum, i) => sum + i.macros.kcal, 0);
    expect(itemKcal).toBe(640);
    expect(merged.items[0].grams).toBe(188); // 200 g × 640 / 680
  });

  it('lowers confidence one level when totals differ by more than 20 %', () => {
    const merged = mergeSamples([estimate({ kcal: 500, confidence: 'high' }), estimate({ kcal: 700, confidence: 'high' })]);
    expect(merged.totals.kcal).toBe(600);
    expect(merged.confidence).toBe('medium');
    expect(merged.assumptions.some((a) => a.includes('differed by 33%'))).toBe(true);
  });

  it('never lowers below low and keeps a single sample as is', () => {
    const merged = mergeSamples([estimate({ kcal: 300, confidence: 'low' }), estimate({ kcal: 900, confidence: 'low' })]);
    expect(merged.confidence).toBe('low');
    const single = estimate({ kcal: 400 });
    expect(mergeSamples([single])).toEqual({ ...single, samples: 1 });
  });

  it('ignores a sample that found no food but forces low confidence', () => {
    const empty = estimate({ kcal: 0, items: [], kcalLow: 0, kcalHigh: 0, confidence: 'low' });
    const merged = mergeSamples([empty, estimate({ kcal: 500, confidence: 'high' })]);
    expect(merged.totals.kcal).toBe(500);
    expect(merged.confidence).toBe('low');
    expect(merged.samples).toBe(2);
    expect(merged.assumptions).toContain('1 of 2 independent estimates found no food in these photos.');
  });

  it('takes brand / barcode from whichever sample found them', () => {
    const merged = mergeSamples([
      estimate({ kcal: 500, confidence: 'high', brand: null }),
      estimate({ kcal: 500, brand: 'Barilla', barcode: '8076809513753' }),
    ]);
    expect(merged.brand).toBe('Barilla');
    expect(merged.barcode).toBe('8076809513753');
  });
});
