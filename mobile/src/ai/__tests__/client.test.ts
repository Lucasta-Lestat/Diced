/// <reference types="jest" />
import Anthropic from '@anthropic-ai/sdk';
import { getSecret, getSettings } from '../../config/settings';
import {
  AiApiError,
  AiNotConfiguredError,
  AiRefusalError,
  assertNotRefused,
  DEFAULT_MODEL,
  getAnthropic,
  resetAnthropicClient,
  resolveModel,
  setAnthropicClientForTests,
  testAnthropicKey,
  toAiError,
} from '../client';
import { errorBody, fakeAnthropic, fakeFetch } from '../testing/fakeAnthropic';

jest.mock('../../config/settings', () => ({
  getSecret: jest.fn(),
  getSettings: jest.fn(),
}));

const mockGetSecret = getSecret as jest.MockedFunction<typeof getSecret>;
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>;

const modelInfo = { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model', created_at: '2026-09-01T00:00:00Z' };

beforeEach(() => {
  jest.clearAllMocks();
  setAnthropicClientForTests(null);
  resetAnthropicClient();
  mockGetSecret.mockResolvedValue('sk-ant-one');
  mockGetSettings.mockResolvedValue({ model: 'claude-opus-5-5' } as never);
});

describe('getAnthropic', () => {
  it('throws AiNotConfiguredError without a key', async () => {
    mockGetSecret.mockResolvedValue(null);
    await expect(getAnthropic()).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it('caches the client per key and rebuilds after a key change or reset', async () => {
    const a = await getAnthropic();
    expect(await getAnthropic()).toBe(a);
    expect(a.apiKey).toBe('sk-ant-one');
    expect(a.maxRetries).toBe(2);
    expect(a.timeout).toBe(120_000);

    mockGetSecret.mockResolvedValue('sk-ant-two');
    const b = await getAnthropic();
    expect(b).not.toBe(a);
    expect(b.apiKey).toBe('sk-ant-two');

    resetAnthropicClient();
    expect(await getAnthropic()).not.toBe(b);
  });

  it('uses the injected test client', async () => {
    const { client } = fakeAnthropic(() => ({ body: {} }));
    setAnthropicClientForTests(client);
    mockGetSecret.mockResolvedValue(null);
    expect(await getAnthropic()).toBe(client);
  });
});

describe('resolveModel', () => {
  it('uses the model from settings, or the default when blank', async () => {
    mockGetSettings.mockResolvedValue({ model: 'claude-sonnet-5-5' } as never);
    expect(await resolveModel()).toBe('claude-sonnet-5-5');
    mockGetSettings.mockResolvedValue({ model: '  ' } as never);
    expect(await resolveModel()).toBe(DEFAULT_MODEL);
  });
});

describe('assertNotRefused', () => {
  it('throws AiRefusalError carrying the category', () => {
    expect(() => assertNotRefused({ stop_reason: 'refusal', stop_details: { category: 'bio', explanation: null } }, 'read the scale')).toThrow(
      new AiRefusalError('Claude declined to read the scale (bio).', 'bio'),
    );
    try {
      assertNotRefused({ stop_reason: 'refusal', stop_details: null }, 'x');
    } catch (e) {
      expect(e).toBeInstanceOf(AiRefusalError);
      expect((e as AiRefusalError).category).toBeNull();
    }
  });

  it('passes other stop reasons', () => {
    expect(() => assertNotRefused({ stop_reason: 'end_turn' }, 'x')).not.toThrow();
  });
});

describe('toAiError', () => {
  const apiError = (status: number, type: string) =>
    Anthropic.APIError.generate(status, errorBody(type, 'boom'), 'boom', new Headers());

  it.each([
    [401, 'authentication_error', 'auth', /Claude API key rejected/],
    [403, 'permission_error', 'permission', /isn't allowed to use claude-opus-5-5/],
    [404, 'not_found_error', 'not_found', /model "claude-opus-5-5" was not found/],
    [429, 'rate_limit_error', 'rate_limit', /rate limit/],
    [400, 'invalid_request_error', 'bad_request', /rejected the request/],
    [529, 'overloaded_error', 'overloaded', /temporarily unavailable/],
    [500, 'api_error', 'overloaded', /temporarily unavailable/],
  ])('maps HTTP %i to kind %s', (status, type, kind, message) => {
    const mapped = toAiError(apiError(status, type), 'claude-opus-5-5');
    expect(mapped).toBeInstanceOf(AiApiError);
    expect(mapped).toMatchObject({ kind, status });
    expect((mapped as Error).message).toMatch(message);
  });

  it('maps connection problems and passes unrelated errors through', () => {
    expect(toAiError(new Anthropic.APIConnectionTimeoutError(), 'm')).toMatchObject({ kind: 'timeout' });
    expect(toAiError(new Anthropic.APIConnectionError({ message: 'offline' }), 'm')).toMatchObject({ kind: 'network' });
    expect(toAiError(new Anthropic.APIUserAbortError(), 'm')).toMatchObject({ kind: 'aborted' });
    const plain = new Error('x');
    expect(toAiError(plain, 'm')).toBe(plain);
  });
});

describe('testAnthropicKey', () => {
  it('retrieves the configured model (no tokens billed) and reports success', async () => {
    const { client, requests } = fakeAnthropic(() => ({ body: modelInfo }));
    setAnthropicClientForTests(client);
    await expect(testAnthropicKey()).resolves.toEqual({ ok: true, message: 'Connected — Claude Opus 5.5 is available.' });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toMatch(/\/v1\/models\/claude-opus-5-5$/);
  });

  it('explains a rejected key, an unknown model and a missing key', async () => {
    setAnthropicClientForTests(fakeAnthropic(() => ({ status: 401, body: errorBody('authentication_error', 'invalid x-api-key') })).client);
    expect(await testAnthropicKey()).toEqual({ ok: false, message: expect.stringMatching(/key rejected/) });

    setAnthropicClientForTests(fakeAnthropic(() => ({ status: 404, body: errorBody('not_found_error', 'model') })).client);
    expect(await testAnthropicKey()).toEqual({ ok: false, message: expect.stringMatching(/was not found/) });

    setAnthropicClientForTests(null);
    mockGetSecret.mockResolvedValue(null);
    expect(await testAnthropicKey()).toEqual({ ok: false, message: 'No Claude API key saved yet.' });
  });

  it('can test a key before it is saved', async () => {
    const original = globalThis.fetch;
    const { fetch, requests } = fakeFetch(() => ({ body: modelInfo }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    try {
      mockGetSecret.mockResolvedValue(null);
      const result = await testAnthropicKey('  sk-ant-unsaved  ');
      expect(result.ok).toBe(true);
      expect(requests[0].headers['x-api-key']).toBe('sk-ant-unsaved');
    } finally {
      globalThis.fetch = original;
    }
  });
});
