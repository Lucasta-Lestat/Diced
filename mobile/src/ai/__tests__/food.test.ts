/// <reference types="jest" />
import { getSecret, getSettings } from '../../config/settings';
import type { LibraryItem } from '../../types';
import { FALLBACK_BETA, setAnthropicClientForTests } from '../client';
import { estimateMeal, type MealEstimateInput } from '../food';
import { FOOD_SYSTEM } from '../prompts';
import { type CapturedRequest, fakeAnthropic, messageBody, tinyImage } from '../testing/fakeAnthropic';

jest.mock('../../config/settings', () => ({
  getSecret: jest.fn(),
  getSettings: jest.fn(),
}));

type Block = { type: string; text?: string };
const contentOf = (req: CapturedRequest) => (req.body!.messages as { content: Block[] }[])[0].content;

const food = (kcal: number, over: Record<string, unknown> = {}) => ({
  contains_food: true,
  title: 'Salmon and potatoes',
  method: 'photo',
  items: [
    { name: 'salmon fillet', portion: '1 fillet', grams: 150, kcal: kcal * 0.6, protein_g: 30, carbs_g: 0, fat_g: 18, basis: 'estimate', confidence: 'medium', usda_query: 'fish, salmon, atlantic, cooked' },
    { name: 'roast potatoes', portion: '1 cup', grams: 180, kcal: kcal * 0.4, protein_g: 4, carbs_g: 40, fat_g: 6, basis: 'estimate', confidence: 'medium', usda_query: 'potatoes, roasted' },
  ],
  kcal_low: kcal * 0.8,
  kcal_high: kcal * 1.25,
  confidence: 'medium',
  questions: [{ question: 'How much oil on the potatoes?', options: ['None', '1 tsp', '1 tbsp'], affects: ['roast potatoes'], kcal_swing: 120 }],
  assumptions: ['Potatoes roasted with some oil'],
  library_item_id: null,
  brand: null,
  barcode: null,
  ...over,
});

const library: LibraryItem[] = [
  {
    id: 'lib-oats',
    name: 'Overnight oats',
    serving: '1 jar',
    macros: { kcal: 420, proteinG: 22, carbsG: 55, fatG: 12 },
    aliases: ['oats'],
    addedBy: 'Her',
    uses: 12,
    updatedAt: 0,
    synced: true,
  },
];

const input = (over: Partial<MealEstimateInput> = {}): MealEstimateInput => ({
  images: [
    { image: tinyImage('before'), takenAt: 1_700_000_000_000 },
    { image: tinyImage('after'), takenAt: 1_700_000_000_000 + 25 * 60_000 },
  ],
  slot: 'dinner',
  notes: 'shared the potatoes with my partner',
  answers: [{ question: 'Was it cooked in butter?', answer: 'No' }],
  library,
  plateDiameterIn: 10.5,
  accuracyMode: 'standard',
  ...over,
});

beforeEach(() => {
  (getSecret as jest.Mock).mockResolvedValue('sk-ant-test');
  (getSettings as jest.Mock).mockResolvedValue({ model: 'claude-opus-5-5' });
});

afterEach(() => setAnthropicClientForTests(null));

describe('estimateMeal (standard)', () => {
  it('sends photos first with effort high and converts the answer', async () => {
    const fake = fakeAnthropic(() => ({ body: messageBody({ json: food(600), model: 'claude-opus-5' }) }));
    setAnthropicClientForTests(fake.client);
    const est = await estimateMeal(input());

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.headers['anthropic-beta'].split(',')).toContain(FALLBACK_BETA);
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      system: [{ text: FOOD_SYSTEM }],
    });
    for (const key of ['thinking', 'temperature', 'top_p']) expect(req.body).not.toHaveProperty(key);

    const content = contentOf(req);
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect(content[0].text).toMatch(/^Photo 1 \(\d\d:\d\d\):$/);
    const text = content[4].text!;
    expect(text).toContain('Meal slot (from the time of day; may be wrong): dinner.');
    expect(text).toContain('Photo 2 at +25 min');
    expect(text).toContain('10.5 in (27 cm)');
    expect(text).toContain('<notes>\nshared the potatoes with my partner\n</notes>');
    expect(text).toContain('- Was it cooked in butter? → No');
    expect(text).toContain('- id lib-oats | Overnight oats | serving: 1 jar | 420 kcal, protein 22 g, carbs 55 g, fat 12 g | also called: oats');

    // Totals come from the items; the served-by model is recorded (server-side fallback).
    expect(est.totals.kcal).toBe(600);
    expect(est.model).toBe('claude-opus-5');
    expect(est.samples).toBe(1);
    expect(est.questions).toEqual([{ id: 'q1', question: 'How much oil on the potatoes?', options: ['None', '1 tsp', '1 tbsp'], affects: ['roast potatoes'] }]);
  });

  it('sends a single photo without a label', async () => {
    const fake = fakeAnthropic(() => ({ body: messageBody({ json: food(500) }) }));
    setAnthropicClientForTests(fake.client);
    await estimateMeal(input({ images: [{ image: tinyImage(), takenAt: 0 }], notes: '', answers: [], library: [], plateDiameterIn: null }));
    const content = contentOf(fake.requests[0]);
    expect(content.map((b) => b.type)).toEqual(['image', 'text']);
    expect(content[1].text).not.toMatch(/notes|Usual meals|plate/);
  });

  it('rejects an empty photo list without calling Claude', async () => {
    const fake = fakeAnthropic(() => ({ body: messageBody({ json: food(500) }) }));
    setAnthropicClientForTests(fake.client);
    await expect(estimateMeal(input({ images: [] }))).rejects.toThrow(/at least one photo/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('estimateMeal (thorough)', () => {
  it('runs two independent requests and merges them', async () => {
    const totals = [500, 700];
    const fake = fakeAnthropic((_req, i) => ({ body: messageBody({ json: food(totals[i], { confidence: 'high' }) }) }));
    setAnthropicClientForTests(fake.client);
    const est = await estimateMeal(input({ accuracyMode: 'thorough' }));

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].body).toEqual(fake.requests[1].body);
    expect(est.samples).toBe(2);
    expect(est.totals.kcal).toBe(600);
    expect(est.kcalLow).toBe(400);
    expect(est.kcalHigh).toBe(875);
    expect(est.confidence).toBe('medium'); // high, lowered: the totals differ by 33 %
  });

  it('keeps the successful sample when the other one fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAnthropic((_req, i) =>
      i === 0
        ? { body: messageBody({ content: [], stopReason: 'refusal', stopDetails: { category: null, explanation: null } }) }
        : { body: messageBody({ json: food(640) }) },
    );
    setAnthropicClientForTests(fake.client);
    const est = await estimateMeal(input({ accuracyMode: 'thorough' }));
    expect(est.samples).toBe(1);
    expect(est.totals.kcal).toBe(640);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 of 2 estimates failed/), expect.anything());
    warn.mockRestore();
  });

  it('throws when every sample fails', async () => {
    const fake = fakeAnthropic(() => ({ body: messageBody({ content: [], stopReason: 'refusal' }) }));
    setAnthropicClientForTests(fake.client);
    await expect(estimateMeal(input({ accuracyMode: 'thorough' }))).rejects.toThrow(/declined/);
  });
});
