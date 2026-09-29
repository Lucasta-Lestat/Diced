/// <reference types="jest" />
import { getSecret, getSettings } from '../../config/settings';
import { AiRefusalError, FALLBACK_BETA, setAnthropicClientForTests } from '../client';
import { RESTAURANT_SYSTEM } from '../prompts';
import { lookupPublishedNutrition, MAX_PAUSE_CONTINUATIONS } from '../restaurant';
import { fakeAnthropic, messageBody } from '../testing/fakeAnthropic';

jest.mock('../../config/settings', () => ({
  getSecret: jest.fn(),
  getSettings: jest.fn(),
}));

const report = {
  found: true,
  source_url: 'https://www.chipotle.com/nutrition-calculator',
  item_name: 'Chicken Burrito Bowl',
  kcal: 655,
  protein_g: 52,
  carbs_g: 57,
  fat_g: 24,
  serving_note: '1 bowl, regular, US menu',
};

const searchTurn = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'chipotle chicken burrito bowl nutrition' } },
];
const reportTurn = (input: unknown) => [
  { type: 'text', text: 'Found the official numbers.' },
  { type: 'tool_use', id: 'toolu_1', name: 'report_nutrition', input },
];

beforeEach(() => {
  (getSecret as jest.Mock).mockResolvedValue('sk-ant-test');
  (getSettings as jest.Mock).mockResolvedValue({ model: 'claude-opus-5-5' });
});

afterEach(() => setAnthropicClientForTests(null));

describe('lookupPublishedNutrition', () => {
  it('declares web search + a strict report tool and returns the report', async () => {
    const fake = fakeAnthropic(() => ({ body: messageBody({ content: reportTurn(report), stopReason: 'tool_use' }) }));
    setAnthropicClientForTests(fake.client);
    const result = await lookupPublishedNutrition('Chipotle', 'Chicken burrito bowl');

    expect(result).toEqual({
      source: 'https://www.chipotle.com/nutrition-calculator',
      itemName: 'Chicken Burrito Bowl',
      macros: { kcal: 655, proteinG: 52, carbsG: 57, fatG: 24 },
      servingNote: '1 bowl, regular, US menu',
    });
    const req = fake.requests[0];
    expect(req.headers['anthropic-beta'].split(',')).toContain(FALLBACK_BETA);
    expect(req.headers['x-stainless-timeout']).toBe('300');
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      tool_choice: { type: 'auto' },
      output_config: { effort: 'medium' },
      system: [{ text: RESTAURANT_SYSTEM }],
    });
    for (const key of ['thinking', 'temperature']) expect(req.body).not.toHaveProperty(key);
    const tools = req.body!.tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    expect(tools[1]).toMatchObject({ name: 'report_nutrition', strict: true, input_schema: { type: 'object', additionalProperties: false } });
    expect((tools[1].input_schema as { required: string[] }).required).toHaveLength(8);
  });

  it('resumes a paused turn by sending the assistant content back', async () => {
    const fake = fakeAnthropic((_req, i) =>
      i === 0
        ? { body: messageBody({ content: searchTurn, stopReason: 'pause_turn' }) }
        : { body: messageBody({ content: reportTurn(report), stopReason: 'tool_use' }) },
    );
    setAnthropicClientForTests(fake.client);
    const result = await lookupPublishedNutrition('Chipotle', 'Chicken burrito bowl');

    expect(result?.macros.kcal).toBe(655);
    expect(fake.requests).toHaveLength(2);
    const messages = fake.requests[1].body!.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toEqual(searchTurn);
  });

  it(`gives up after ${MAX_PAUSE_CONTINUATIONS} continuations`, async () => {
    const fake = fakeAnthropic(() => ({ body: messageBody({ content: searchTurn, stopReason: 'pause_turn' }) }));
    setAnthropicClientForTests(fake.client);
    expect(await lookupPublishedNutrition('Chipotle', 'Bowl')).toBeNull();
    expect(fake.requests).toHaveLength(MAX_PAUSE_CONTINUATIONS + 1);
  });

  it('returns null when nothing was found or no report was made', async () => {
    const notFound = { found: false, source_url: null, item_name: null, kcal: null, protein_g: null, carbs_g: null, fat_g: null, serving_note: null };
    setAnthropicClientForTests(fakeAnthropic(() => ({ body: messageBody({ content: reportTurn(notFound), stopReason: 'tool_use' }) })).client);
    expect(await lookupPublishedNutrition('Joe’s Diner', 'Club sandwich')).toBeNull();

    setAnthropicClientForTests(fakeAnthropic(() => ({ body: messageBody({ text: 'I could not find it.' }) })).client);
    expect(await lookupPublishedNutrition('Joe’s Diner', 'Club sandwich')).toBeNull();
  });

  it('skips the call for a blank brand or dish', async () => {
    const fake = fakeAnthropic(() => ({ body: messageBody({ text: 'x' }) }));
    setAnthropicClientForTests(fake.client);
    expect(await lookupPublishedNutrition('  ', 'Bowl')).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it('throws on a refusal', async () => {
    setAnthropicClientForTests(fakeAnthropic(() => ({ body: messageBody({ content: [], stopReason: 'refusal' }) })).client);
    await expect(lookupPublishedNutrition('Chipotle', 'Bowl')).rejects.toBeInstanceOf(AiRefusalError);
  });
});
