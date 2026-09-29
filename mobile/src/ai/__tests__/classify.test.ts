/// <reference types="jest" />
import { getSecret, getSettings } from '../../config/settings';
import { classifyBatch, type ClassifyInput } from '../classify';
import { setAnthropicClientForTests } from '../client';
import { CLASSIFY_SYSTEM } from '../prompts';
import { fakeAnthropic, messageBody, type CapturedRequest } from '../testing/fakeAnthropic';

jest.mock('../../config/settings', () => ({
  getSecret: jest.fn(),
  getSettings: jest.fn(),
}));

type Block = { type: string; text?: string; source?: { data: string } };
const contentOf = (req: CapturedRequest) => (req.body!.messages as { content: Block[] }[])[0].content;
const inputs = (n: number): ClassifyInput[] => Array.from({ length: n }, (_, i) => ({ assetId: `asset-${i}`, image: { base64: `IMG${i}`, mediaType: 'image/jpeg', width: 384, height: 288 } }));

/** Answers "food" for every photo in the request. */
function answerAllFood(req: CapturedRequest) {
  const count = contentOf(req).filter((b) => b.type === 'image').length;
  return { body: messageBody({ json: { photos: Array.from({ length: count }, (_, i) => ({ photo: i + 1, category: 'food', confidence: 0.9 })) } }) };
}

beforeEach(() => {
  (getSecret as jest.Mock).mockResolvedValue('sk-ant-test');
  (getSettings as jest.Mock).mockResolvedValue({ model: 'claude-opus-5-5' });
});

afterEach(() => setAnthropicClientForTests(null));

describe('classifyBatch', () => {
  it('sends labelled thumbnails before the instructions, effort low', async () => {
    const fake = fakeAnthropic(() => ({
      body: messageBody({
        json: {
          photos: [
            { photo: 1, category: 'scale', confidence: 0.95 },
            { photo: 2, category: 'nutrition_label', confidence: 0.7 },
          ],
        },
      }),
    }));
    setAnthropicClientForTests(fake.client);
    const result = await classifyBatch(inputs(3));

    expect(result).toEqual({
      'asset-0': { category: 'scale', confidence: 0.95 },
      'asset-1': { category: 'nutrition_label', confidence: 0.7 },
      'asset-2': { category: 'other', confidence: 0 },
    });
    const req = fake.requests[0];
    expect(req.headers['x-stainless-timeout']).toBe('120');
    expect(req.body).toMatchObject({
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: [{ text: CLASSIFY_SYSTEM }],
    });
    expect(req.body).not.toHaveProperty('thinking');
    const content = contentOf(req);
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text', 'image', 'text']);
    expect(content[0].text).toBe('Photo 1:');
    expect(content[3].source?.data).toBe('IMG1');
    expect(content[6].text).toBe('Classify these 3 photos (Photo 1 to Photo 3).');
  });

  it('splits more than 16 thumbnails into several requests', async () => {
    const fake = fakeAnthropic(answerAllFood);
    setAnthropicClientForTests(fake.client);
    const result = await classifyBatch(inputs(20));
    expect(fake.requests.map((r) => contentOf(r).filter((b) => b.type === 'image').length)).toEqual([16, 4]);
    expect(Object.keys(result)).toHaveLength(20);
    expect(result['asset-19']).toEqual({ category: 'food', confidence: 0.9 });
  });

  it('makes no request for an empty batch', async () => {
    const fake = fakeAnthropic(answerAllFood);
    setAnthropicClientForTests(fake.client);
    expect(await classifyBatch([])).toEqual({});
    expect(fake.requests).toHaveLength(0);
  });
});
