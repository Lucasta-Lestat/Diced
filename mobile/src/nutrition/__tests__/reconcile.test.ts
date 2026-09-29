/// <reference types="jest" />
import { lookupPublishedNutrition } from '../../ai/restaurant';
import type { FoodItem, MealEstimate } from '../../types';
import { lookupBarcode, type OffProduct } from '../openfoodfacts';
import { reconcileEstimate, rescaleRange, scaleMacros, sumMacros } from '../reconcile';
import { searchUsda, type UsdaFood } from '../usda';

jest.mock('../usda', () => ({ searchUsda: jest.fn() }));
jest.mock('../openfoodfacts', () => ({
  ...jest.requireActual('../openfoodfacts'),
  lookupBarcode: jest.fn(),
}));
jest.mock('../../ai/restaurant', () => ({ lookupPublishedNutrition: jest.fn() }));

const mockUsda = jest.mocked(searchUsda);
const mockBarcode = jest.mocked(lookupBarcode);
const mockPublished = jest.mocked(lookupPublishedNutrition);

function item(name: string, grams: number | null, kcal: number, patch: Partial<FoodItem> = {}): FoodItem {
  return {
    name,
    portion: grams ? `${grams} g` : '1 item',
    grams,
    macros: { kcal, proteinG: 10, carbsG: 10, fatG: 5 },
    source: 'model',
    confidence: 'high',
    usdaQuery: name,
    fdcId: null,
    modelMacros: null,
    ...patch,
  };
}

function estimate(items: FoodItem[], patch: Partial<MealEstimate> = {}): MealEstimate {
  const totals = sumMacros(items);
  return {
    title: 'Chicken and rice',
    items,
    totals,
    kcalLow: Math.round(totals.kcal * 0.8),
    kcalHigh: Math.round(totals.kcal * 1.3),
    confidence: 'high',
    method: 'photo',
    questions: [],
    assumptions: ['cooked in 1 tsp oil'],
    libraryItemId: null,
    brand: null,
    barcode: null,
    model: 'claude-opus-5-5',
    samples: 1,
    createdAt: 1,
    ...patch,
  };
}

function usda(fdcId: number, kcal: number, proteinG = 20, carbsG = 0, fatG = 5): UsdaFood {
  return { fdcId, description: `food ${fdcId}`, dataType: 'SR Legacy', per100g: { kcal, proteinG, carbsG, fatG } };
}

const OPTS = { useUsda: true, webLookupForRestaurants: true };

beforeEach(() => {
  jest.resetAllMocks();
  mockUsda.mockResolvedValue(null);
  mockBarcode.mockResolvedValue(null);
  mockPublished.mockResolvedValue(null);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('pure helpers', () => {
  it('sums and rounds macros', () => {
    expect(sumMacros([{ macros: { kcal: 100.4, proteinG: 1.26, carbsG: 2.5, fatG: 0.2 } }, { macros: { kcal: 50.4, proteinG: 1.3, carbsG: 0, fatG: 0.2 } }])).toEqual({
      kcal: 151,
      proteinG: 3,
      carbsG: 3,
      fatG: 0,
    });
    expect(sumMacros([])).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  });

  it('scales per-100 g values to grams', () => {
    expect(scaleMacros({ kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6 }, 150)).toEqual({ kcal: 248, proteinG: 46.5, carbsG: 0, fatG: 5.4 });
    expect(scaleMacros({ kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6 }, -5).kcal).toBe(0);
  });

  it('moves the range proportionally to the new total', () => {
    expect(rescaleRange(400, 600, 500, 600)).toEqual({ low: 480, high: 720 });
    expect(rescaleRange(0, 0, 0, 400)).toEqual({ low: 300, high: 500 });
    // A malformed range still brackets the total.
    expect(rescaleRange(700, 300, 500, 500)).toEqual({ low: 500, high: 500 });
  });
});

describe('reconcileEstimate — USDA', () => {
  it('replaces model numbers with USDA × grams and keeps the model numbers', async () => {
    mockUsda.mockImplementation(async (q) => (q === 'chicken breast' ? usda(171477, 165, 31, 0, 3.6) : usda(169756, 130, 2.7, 28, 0.3)));
    const input = estimate([item('chicken breast', 150, 230), item('white rice', 180, 250)]);
    const out = await reconcileEstimate(input, OPTS);

    expect(out.items[0]).toMatchObject({
      source: 'usda',
      fdcId: 171477,
      macros: { kcal: 248, proteinG: 46.5, carbsG: 0, fatG: 5.4 },
      modelMacros: input.items[0].macros,
      confidence: 'high',
    });
    expect(out.items[1].macros.kcal).toBe(234);
    expect(out.totals).toEqual({ kcal: 482, proteinG: 51, carbsG: 50, fatG: 6 });
    expect(out.kcalLow).toBe(Math.round(482 * (input.kcalLow / 480)));
    expect(out.kcalHigh).toBe(Math.round(482 * (input.kcalHigh / 480)));
    expect(out.confidence).toBe('high');
    expect(out.assumptions).toEqual(['cooked in 1 tsp oil']);
    expect(input.items[0].source).toBe('model');
  });

  it('flags a > 35 % disagreement and lowers confidence one level', async () => {
    mockUsda.mockResolvedValueOnce(usda(1, 130)).mockResolvedValueOnce(usda(2, 50));
    const out = await reconcileEstimate(estimate([item('white rice', 300, 250), item('broccoli', 100, 45)]), OPTS);
    expect(out.items[0].macros.kcal).toBe(390);
    expect(out.items[0].confidence).toBe('medium');
    expect(out.assumptions).toEqual(['cooked in 1 tsp oil', 'check_portion:white rice']);
    expect(out.confidence).toBe('medium');
  });

  it('does not flag small items with a big relative difference', async () => {
    mockUsda.mockResolvedValue(usda(1, 40));
    const out = await reconcileEstimate(estimate([item('lemon wedge', 20, 2)]), OPTS);
    expect(out.items[0].macros.kcal).toBe(8);
    expect(out.assumptions).not.toContainEqual(expect.stringMatching(/^check_portion:/));
    expect(out.confidence).toBe('high');
  });

  it('keeps authoritative items and items without grams or query', async () => {
    mockUsda.mockResolvedValue(usda(1, 999));
    const items = [
      item('granola (label)', 50, 220, { source: 'label' }),
      item('usual oats', 200, 350, { source: 'library' }),
      item('mystery sauce', null, 80),
      item('side salad', 100, 60, { usdaQuery: null }),
    ];
    const out = await reconcileEstimate(estimate(items), OPTS);
    expect(mockUsda).not.toHaveBeenCalled();
    expect(out.items.map((i) => i.macros.kcal)).toEqual([220, 350, 80, 60]);
  });

  it('skips USDA when disabled and keeps model numbers when a lookup fails', async () => {
    const input = estimate([item('chicken breast', 150, 230), item('white rice', 180, 250)]);
    expect((await reconcileEstimate(input, { ...OPTS, useUsda: false })).totals.kcal).toBe(480);
    expect(mockUsda).not.toHaveBeenCalled();

    mockUsda.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(usda(2, 130));
    const out = await reconcileEstimate(input, OPTS);
    expect(out.items[0].source).toBe('model');
    expect(out.items[1].source).toBe('usda');
    expect(out.totals.kcal).toBe(230 + 234);
  });

  it('keeps the totals of an estimate without items', async () => {
    const input = { ...estimate([]), totals: { kcal: 300, proteinG: 10, carbsG: 40, fatG: 9 }, kcalLow: 250, kcalHigh: 350 };
    const out = await reconcileEstimate(input, OPTS);
    expect(out.totals).toEqual(input.totals);
    expect([out.kcalLow, out.kcalHigh]).toEqual([250, 350]);
  });
});

describe('reconcileEstimate — barcode', () => {
  const product = (patch: Partial<OffProduct> = {}): OffProduct => ({
    code: '5449000000996',
    name: 'Coca-Cola Original',
    brand: 'Coca-Cola',
    servingSizeG: 330,
    per100g: { kcal: 42, proteinG: 0, carbsG: 10.6, fatG: 0 },
    perServing: { kcal: 139, proteinG: 0, carbsG: 35, fatG: 0 },
    ...patch,
  });

  it('uses per-100 g × grams for a valid, known barcode and sets method barcode', async () => {
    mockBarcode.mockResolvedValue(product());
    const input = estimate([item('cola can', 330, 120)], { barcode: '5449000000996' });
    const out = await reconcileEstimate(input, OPTS);
    expect(mockBarcode).toHaveBeenCalledWith('5449000000996');
    expect(out.method).toBe('barcode');
    expect(out.items[0]).toMatchObject({ source: 'openfoodfacts', macros: { kcal: 139, carbsG: 35 }, modelMacros: input.items[0].macros });
    expect(out.assumptions[0]).toBe('Nutrition from Open Food Facts: Coca-Cola Coca-Cola Original');
    expect(mockUsda).not.toHaveBeenCalled();
  });

  it('uses the serving when grams are unknown, and matches the product among several items', async () => {
    mockBarcode.mockResolvedValue(product());
    const input = estimate([item('burger', 250, 600), item('Coca-Cola', null, 150)], { barcode: '5449000000996' });
    const out = await reconcileEstimate(input, { ...OPTS, useUsda: false });
    expect(out.items[0].source).toBe('model');
    expect(out.items[1]).toMatchObject({ source: 'openfoodfacts', grams: 330, macros: { kcal: 139 } });
    expect(out.totals.kcal).toBe(739);
  });

  it('ignores invalid or unknown barcodes', async () => {
    const input = estimate([item('cola can', 330, 120)], { barcode: '5449000000997' });
    expect((await reconcileEstimate(input, { ...OPTS, useUsda: false })).method).toBe('photo');
    expect(mockBarcode).not.toHaveBeenCalled();

    const unknown = await reconcileEstimate({ ...input, barcode: '5449000000996' }, { ...OPTS, useUsda: false });
    expect(mockBarcode).toHaveBeenCalledTimes(1);
    expect(unknown.method).toBe('photo');
    expect(unknown.items[0].source).toBe('model');
  });

  it('never throws when the lookup fails', async () => {
    mockBarcode.mockRejectedValue(new Error('offline'));
    const out = await reconcileEstimate(estimate([item('cola can', 330, 120)], { barcode: '5449000000996' }), OPTS);
    expect(out.method).toBe('photo');
  });
});

describe('reconcileEstimate — restaurants', () => {
  const published = {
    source: 'https://www.chipotle.com/nutrition-calculator',
    itemName: 'Chicken burrito bowl',
    macros: { kcal: 655, proteinG: 53, carbsG: 62, fatG: 21.5 },
    servingNote: 'chicken, white rice, black beans, salsa',
  };

  it('uses published nutrition when the meal is that one item, keeping its grams editable', async () => {
    mockPublished.mockResolvedValue(published);
    const input = estimate([item('Chicken burrito bowl', 450, 410)], { brand: 'Chipotle', confidence: 'low', title: 'Burrito bowl' });
    const out = await reconcileEstimate(input, OPTS);
    expect(mockPublished).toHaveBeenCalledWith('Chipotle', 'Chicken burrito bowl', { signal: undefined });
    expect(out.method).toBe('restaurant');
    expect(out.items).toHaveLength(1);
    // The model's served weight is kept, so a grams correction in review scales the published numbers.
    expect(out.items[0]).toMatchObject({ name: 'Chicken burrito bowl', source: 'web', grams: 450, modelMacros: { kcal: 410 } });
    expect(out.totals).toEqual({ kcal: 655, proteinG: 53, carbsG: 62, fatG: 22 });
    expect(out.confidence).toBe('medium');
    expect(out.assumptions[0]).toMatch(/^Published nutrition for Chicken burrito bowl .*chipotle\.com.*photo estimate was 410 kcal$/);
    expect(out.kcalLow).toBe(Math.round(655 * (input.kcalLow / 410)));
    expect(mockUsda).not.toHaveBeenCalled();
  });

  it('replaces only the item the published numbers are for and keeps sides and drinks', async () => {
    mockPublished.mockResolvedValue({ source: 'https://www.mcdonalds.com/us/en-us/product/big-mac.html', itemName: "McDonald's Big Mac", macros: { kcal: 590, proteinG: 25, carbsG: 46, fatG: 34 }, servingNote: '1 sandwich' });
    mockUsda.mockResolvedValue(usda(7, 312, 3.4, 41, 15));
    const input = estimate(
      [item('Big Mac', 215, 540), item('french fries', 110, 330), item('Coca-Cola', 590, 240, { usdaQuery: null })],
      { brand: "McDonald's", title: 'Big Mac, fries and Coke', confidence: 'medium' },
    );
    const out = await reconcileEstimate(input, OPTS);
    expect(mockPublished).toHaveBeenCalledWith("McDonald's", 'Big Mac, fries and Coke', { signal: undefined });
    expect(out.items.map((i) => [i.name, i.source])).toEqual([
      ["McDonald's Big Mac", 'web'],
      ['french fries', 'usda'],
      ['Coca-Cola', 'model'],
    ]);
    expect(out.items[0]).toMatchObject({ grams: 215, macros: { kcal: 590 } });
    expect(out.totals.kcal).toBe(590 + Math.round(312 * 1.1) + 240);
    expect(out.method).toBe('restaurant');
    // Only part of the meal is published, so the meal's confidence isn't raised.
    expect(out.confidence).toBe('medium');
    expect(out.assumptions[0]).toMatch(/photo estimate was 540 kcal$/);
  });

  it("doesn't let a combo figure replace its main item (the sides are listed too)", async () => {
    mockPublished.mockResolvedValue({ source: 'https://www.mcdonalds.com/combo', itemName: 'Big Mac Meal', macros: { kcal: 1080, proteinG: 30, carbsG: 140, fatG: 45 }, servingNote: 'medium' });
    const input = estimate([item('Big Mac', 215, 540), item('french fries', 110, 330)], { brand: "McDonald's", title: 'Big Mac meal' });
    const out = await reconcileEstimate(input, OPTS);
    expect(out.items.map((i) => i.name)).toEqual(['Big Mac', 'french fries']);
    expect(out.method).toBe('photo');
    expect(out.assumptions[0]).toMatch(/for reference; the photo estimate is kept/);
  });

  it('keeps a dish itemised into components and only notes the published figure', async () => {
    mockPublished.mockResolvedValue(published);
    const input = estimate([item('chicken', 120, 200), item('rice', 150, 210)], { brand: 'Chipotle', confidence: 'low', title: 'Burrito bowl' });
    const out = await reconcileEstimate(input, OPTS);
    expect(mockPublished).toHaveBeenCalledWith('Chipotle', 'Burrito bowl', { signal: undefined });
    // Replacing "chicken" with the whole bowl would count the rice twice.
    expect(out.items.map((i) => i.name)).toEqual(['chicken', 'rice']);
    expect(out.method).toBe('photo');
    expect(out.confidence).toBe('low');
    expect(out.totals.kcal).toBe(410);
    expect(out.assumptions[0]).toMatch(/^Published nutrition for Chicken burrito bowl .*: 655 kcal \(for reference; the photo estimate is kept\)$/);
    expect(mockUsda).toHaveBeenCalled();
  });

  it("doesn't let a published whole item override notes, answers or leftovers", async () => {
    mockPublished.mockResolvedValue(published);
    const whole = estimate([item('Chicken burrito bowl', 300, 520)], { brand: 'Chipotle', title: 'Burrito bowl' });
    // "ate half" / "shared with partner" in notes or answers.
    const noted = await reconcileEstimate(whole, { ...OPTS, userContext: true });
    expect(noted.items[0].macros.kcal).toBe(520);
    expect(noted.method).toBe('photo');
    // Before/after photos: the model subtracted what was left.
    const leftovers = await reconcileEstimate({ ...whole, assumptions: ['About a third of the bowl was left on the plate'] }, OPTS);
    expect(leftovers.items[0].macros.kcal).toBe(520);
    expect(mockPublished).not.toHaveBeenCalled();
  });

  it('passes the run\'s abort signal to the web lookup and starts no lookup once it has fired', async () => {
    mockPublished.mockResolvedValue(null);
    const controller = new AbortController();
    const input = estimate([item('Chicken burrito bowl', 300, 520)], { brand: 'Chipotle', barcode: '5449000000996' });
    await reconcileEstimate(input, { ...OPTS, signal: controller.signal });
    expect(mockPublished).toHaveBeenCalledWith('Chipotle', 'Chicken burrito bowl', { signal: controller.signal });

    jest.clearAllMocks();
    controller.abort();
    const out = await reconcileEstimate(input, { ...OPTS, signal: controller.signal });
    expect(mockPublished).not.toHaveBeenCalled();
    expect(mockBarcode).not.toHaveBeenCalled();
    expect(mockUsda).not.toHaveBeenCalled();
    // The model's numbers are kept.
    expect(out.totals.kcal).toBe(520);
  });

  it('is skipped when web lookup is off or the method is not photo', async () => {
    mockPublished.mockResolvedValue(published);
    const input = estimate([item('chicken', 120, 200)], { brand: 'Chipotle' });
    expect((await reconcileEstimate(input, { ...OPTS, webLookupForRestaurants: false })).method).toBe('photo');
    expect((await reconcileEstimate({ ...input, method: 'label' }, OPTS)).method).toBe('label');
    expect(mockPublished).not.toHaveBeenCalled();
  });

  it('falls back to USDA when nothing is published or the lookup fails', async () => {
    mockUsda.mockResolvedValue(usda(1, 165));
    const input = estimate([item('chicken', 100, 150)], { brand: 'Local diner' });
    mockPublished.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('refused'));
    expect((await reconcileEstimate(input, OPTS)).items[0].source).toBe('usda');
    expect((await reconcileEstimate(input, OPTS)).items[0].source).toBe('usda');
  });
});
