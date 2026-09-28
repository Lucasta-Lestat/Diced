/// <reference types="jest" />
import { getSecret } from '../../config/settings';
import { kvGet, kvSet } from '../../db/database';
import { __resetUsdaForTests, pickBestUsdaFood, searchUsda, usdaPer100g } from '../usda';
import search from './fixtures/usdaSearch.json';

jest.mock('../../db/database', () => ({ kvGet: jest.fn(), kvSet: jest.fn() }));
jest.mock('../../config/settings', () => ({ getSecret: jest.fn() }));

const mockKvGet = jest.mocked(kvGet);
const mockKvSet = jest.mocked(kvSet);
const mockGetSecret = jest.mocked(getSecret);
const fetchMock = jest.fn();

const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  __resetUsdaForTests();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockKvGet.mockResolvedValue(null);
  mockKvSet.mockResolvedValue(undefined);
  mockGetSecret.mockResolvedValue(null);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('usdaPer100g', () => {
  it('reads energy 1008 and macros from live-shaped nutrients', () => {
    expect(usdaPer100g(search.broccoliRaw.foods[2].foodNutrients)).toEqual({
      kcal: 34,
      proteinG: 2.82,
      carbsG: 6.64,
      fatG: 0.37,
    });
  });

  it('uses Atwater specific (2048) energy for Foundation foods without 1008', () => {
    expect(usdaPer100g(search.avocado.foods[0].foodNutrients)?.kcal).toBe(206);
    const generalOnly = [{ nutrientId: 2047, nutrientNumber: '957', unitName: 'KCAL', value: 23.9 }];
    expect(usdaPer100g(generalOnly)?.kcal).toBe(23.9);
  });

  it('falls back to NLEA fat and carbohydrate by summation', () => {
    const nutrients = [
      { nutrientId: 2048, unitName: 'KCAL', value: 100 },
      { nutrientId: 1085, unitName: 'G', value: 5 },
      { nutrientId: 1050, unitName: 'G', value: 12 },
    ];
    expect(usdaPer100g(nutrients)).toEqual({ kcal: 100, proteinG: 0, carbsG: 12, fatG: 5 });
  });

  it('accepts the documented number/amount field names', () => {
    const legacy = [
      { number: '208', unitName: 'KCAL', amount: 52 },
      { number: '203', unitName: 'G', amount: 0.3 },
    ];
    expect(usdaPer100g(legacy)).toEqual({ kcal: 52, proteinG: 0.3, carbsG: 0, fatG: 0 });
  });

  it('ignores kJ energy and foods without energy', () => {
    expect(usdaPer100g([{ nutrientId: 1062, unitName: 'kJ', value: 132 }])).toBeNull();
    expect(usdaPer100g(search.oliveOil.foods[3].foodNutrients)).toBeNull();
    expect(usdaPer100g(undefined)).toBeNull();
  });
});

describe('pickBestUsdaFood', () => {
  it('skips foods without energy and keeps the API order for equal matches', () => {
    const food = pickBestUsdaFood('chicken breast', search.chickenBreast);
    // The first hit (Foundation lunchmeat) has no energy data.
    expect(food?.fdcId).toBe(2705964);
    expect(food?.dataType).toBe('Survey (FNDDS)');
    expect(food?.per100g.kcal).toBe(144);
  });

  it('prefers the description that covers the query words', () => {
    expect(pickBestUsdaFood('olive oil', search.oliveOil)?.description).toBe('Olive oil');
    expect(pickBestUsdaFood('broccoli raw', search.broccoliRaw)?.description).toBe('Broccoli, raw');
    expect(pickBestUsdaFood('chicken breast sauteed skin eaten', search.chickenBreast)?.fdcId).toBe(2705971);
  });

  it('returns null for weak matches so the model number is kept', () => {
    expect(pickBestUsdaFood('chicken tikka masala', search.chickenBreast)).toBeNull();
    expect(pickBestUsdaFood('raw', search.broccoliRaw)?.description).toBe('Broccoli, raw');
    expect(pickBestUsdaFood('cooked spinach', search.broccoliRaw)).toBeNull();
    expect(pickBestUsdaFood('', search.broccoliRaw)).toBeNull();
    expect(pickBestUsdaFood('broccoli', { error: { code: 'OVER_RATE_LIMIT' } })).toBeNull();
  });

  it('down-weights Branded foods', () => {
    const body = {
      foods: [
        { fdcId: 1, description: 'Greek yogurt plain', dataType: 'Branded', foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 60 }] },
        { fdcId: 2, description: 'Yogurt, Greek, plain', dataType: 'SR Legacy', foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 59 }] },
      ],
    };
    expect(pickBestUsdaFood('greek yogurt plain', body)?.fdcId).toBe(2);
  });
});

describe('searchUsda', () => {
  it('queries Foundation / SR Legacy / FNDDS with DEMO_KEY and caches the result', async () => {
    fetchMock.mockResolvedValue(response(200, search.oliveOil));
    const food = await searchUsda('  Olive Oil! ');
    expect(food?.fdcId).toBe(2710186);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(
      'https://api.nal.usda.gov/fdc/v1/foods/search?query=olive%20oil&dataType=Foundation,SR%20Legacy,Survey%20(FNDDS)&pageSize=10&api_key=DEMO_KEY',
    );
    expect(mockKvGet).toHaveBeenCalledWith('usda:olive oil');
    expect(mockKvSet).toHaveBeenCalledWith('usda:olive oil', { food, at: expect.any(Number) });
  });

  it("uses the user's key when set", async () => {
    mockGetSecret.mockResolvedValue('my-key');
    fetchMock.mockResolvedValue(response(200, search.oliveOil));
    await searchUsda('olive oil');
    expect(fetchMock.mock.calls[0][0]).toContain('api_key=my-key');
  });

  it('answers from the cache, including a cached "no match"', async () => {
    const food = { fdcId: 1, description: 'x', dataType: 'SR Legacy', per100g: { kcal: 1, proteinG: 0, carbsG: 0, fatG: 0 } };
    mockKvGet.mockResolvedValueOnce({ food, at: 1 });
    expect(await searchUsda('x')).toEqual(food);
    mockKvGet.mockResolvedValueOnce({ food: null, at: 1 });
    expect(await searchUsda('mystery stew')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches weak matches as null', async () => {
    fetchMock.mockResolvedValue(response(200, search.chickenBreast));
    expect(await searchUsda('chicken tikka masala')).toBeNull();
    expect(mockKvSet).toHaveBeenCalledWith('usda:chicken tikka masala', { food: null, at: expect.any(Number) });
  });

  it('returns null without caching on network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    expect(await searchUsda('olive oil')).toBeNull();
    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it('backs off after a rate limit (429)', async () => {
    fetchMock.mockResolvedValue(response(429, { error: { code: 'OVER_RATE_LIMIT' } }));
    expect(await searchUsda('olive oil')).toBeNull();
    expect(await searchUsda('broccoli')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it('aborts a request that takes longer than 10 s', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
          }),
      );
      const pending = searchUsda('olive oil');
      await jest.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores blank queries', async () => {
    expect(await searchUsda(' ?! ')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
