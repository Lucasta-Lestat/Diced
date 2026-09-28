/// <reference types="jest" />
import { getSecret, getSettings } from '../../config/settings';
import { AiApiError, AiRefusalError, AiResponseError, FALLBACK_BETA, setAnthropicClientForTests } from '../client';
import { SCALE_SYSTEM } from '../prompts';
import { readScale, toPounds } from '../scale';
import { errorBody, fakeAnthropic, messageBody, type Responder, tinyImage } from '../testing/fakeAnthropic';

jest.mock('../../config/settings', () => ({
  getSecret: jest.fn(),
  getSettings: jest.fn(),
}));

const scaleJson = {
  is_scale: true,
  display_text: '172.4 lb',
  reading_kind: 'body_weight',
  value: 172.4,
  unit: 'lb',
  stone_pounds: null,
  confidence: 'high',
  issues: [],
};

function install(responder: Responder) {
  const fake = fakeAnthropic(responder);
  setAnthropicClientForTests(fake.client);
  return fake.requests;
}

beforeEach(() => {
  (getSecret as jest.Mock).mockResolvedValue('sk-ant-test');
  (getSettings as jest.Mock).mockResolvedValue({ model: 'claude-opus-5-5' });
});

afterEach(() => setAnthropicClientForTests(null));

describe('toPounds', () => {
  it('converts kg with 2.20462 and rounds to 0.1', () => {
    expect(toPounds(80, 'kg')).toBe(176.4);
    expect(toPounds(78.25, 'kg')).toBe(172.5);
    expect(toPounds(172.44, 'lb')).toBe(172.4);
    expect(toPounds(172.46, 'lb')).toBe(172.5);
  });
});

describe('readScale', () => {
  it('sends one structured request with the required shape', async () => {
    const requests = install(() => ({ body: messageBody({ json: scaleJson }) }));
    const reading = await readScale(tinyImage('scale'), { expectedUnit: 'lb', recentLb: 180 });
    expect(reading).toEqual({ isScale: true, value: 172.4, unit: 'lb', confidence: 'high', issues: [] });

    expect(requests).toHaveLength(1);
    const { url, headers, body } = requests[0];
    expect(url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(headers['anthropic-beta'].split(',')).toContain(FALLBACK_BETA);
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      system: [{ type: 'text', text: SCALE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    });
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'betas']) expect(body).not.toHaveProperty(key);

    const messages = body!.messages as { role: string; content: { type: string; source?: unknown; text?: string }[] }[];
    expect(messages).toHaveLength(1); // no assistant prefill
    expect(messages[0].role).toBe('user');
    const [first, last] = [messages[0].content[0], messages[0].content[messages[0].content.length - 1]];
    expect(first).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64-scale' } });
    expect(last.type).toBe('text');
    expect(last.text).toMatch(/around 180\.0 lb \(81\.6 kg\)/);
  });

  it('uses the model from settings', async () => {
    (getSettings as jest.Mock).mockResolvedValue({ model: 'claude-opus-5' });
    const requests = install(() => ({ body: messageBody({ json: scaleJson }) }));
    await readScale(tinyImage(), { expectedUnit: 'lb', recentLb: null });
    expect(requests[0].body!.model).toBe('claude-opus-5');
    expect(String((requests[0].body!.messages as { content: { text?: string }[] }[])[0].content[1].text)).not.toMatch(/recent weigh-ins/);
  });

  it('throws AiRefusalError with the category before reading content', async () => {
    install(() => ({
      body: messageBody({ content: [], stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'general_harms', explanation: null } }),
    }));
    const promise = readScale(tinyImage(), { expectedUnit: 'lb', recentLb: null });
    await expect(promise).rejects.toBeInstanceOf(AiRefusalError);
    await expect(promise).rejects.toMatchObject({ category: 'general_harms' });
  });

  it('refusal wins even when partial text would not parse', async () => {
    install(() => ({ body: messageBody({ text: '{"is_scale": tr', stopReason: 'refusal' }) }));
    await expect(readScale(tinyImage(), { expectedUnit: 'lb', recentLb: null })).rejects.toBeInstanceOf(AiRefusalError);
  });

  it.each([
    ['cut off at max_tokens', messageBody({ text: '{"is_scale": tr', stopReason: 'max_tokens' }), /cut off/],
    ['output that does not match the schema', messageBody({ json: { hello: 'world' } }), /didn't match the expected format/],
    ['no text at all', messageBody({ content: [] }), /returned no answer.*end_turn/],
  ])('throws AiResponseError when parsed_output is null: %s', async (_name, body, message) => {
    install(() => ({ body }));
    const promise = readScale(tinyImage(), { expectedUnit: 'lb', recentLb: null });
    await expect(promise).rejects.toBeInstanceOf(AiResponseError);
    await expect(promise).rejects.toThrow(message);
  });

  it('maps a rejected key to a clear message', async () => {
    install(() => ({ status: 401, body: errorBody('authentication_error', 'invalid x-api-key') }));
    const promise = readScale(tinyImage(), { expectedUnit: 'lb', recentLb: null });
    await expect(promise).rejects.toBeInstanceOf(AiApiError);
    await expect(promise).rejects.toMatchObject({ kind: 'auth', message: 'Claude API key rejected — check it in Settings.' });
  });

  it('honours an abort signal', async () => {
    install(() => ({ body: messageBody({ json: scaleJson }) }));
    const controller = new AbortController();
    controller.abort();
    await expect(readScale(tinyImage(), { expectedUnit: 'lb', recentLb: null }, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
  });
});
