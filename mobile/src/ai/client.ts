/**
 * Anthropic client for React Native. OWNER: AI builder.
 * - API key from SecureStore (`anthropicApiKey`); `dangerouslyAllowBrowser: true` (RN looks
 *   browser-like to the SDK; the key is the user's own and stays on their device).
 * - All calls use `client.beta.messages.parse/create` with `betas: ['server-side-fallback-2026-07-01']`
 *   and `fallbacks: 'default'`, and handle `stop_reason === 'refusal'`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getSecret, getSettings } from '../config/settings';
import { errorMessage } from '../lib/log';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Per attempt; the SDK retries timeouts and 408/409/429/5xx up to MAX_RETRIES times. */
export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_RETRIES = 2;

export class AiNotConfiguredError extends Error {
  constructor(message = 'Add your Claude API key in Settings first.') {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

export class AiRefusalError extends Error {
  /** `stop_details.category` (e.g. `cyber`, `bio`, `general_harms`), null when not named. */
  readonly category: string | null;

  constructor(message = 'Claude declined this request.', category: string | null = null) {
    super(message);
    this.name = 'AiRefusalError';
    this.category = category;
  }
}

export type AiApiErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'bad_request'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'other';

/**
 * A failed Claude call with a user-facing message. `kind: 'auth'` means every further call will
 * fail too, so a run can stop early instead of erroring on each photo.
 */
export class AiApiError extends Error {
  readonly kind: AiApiErrorKind;
  readonly status: number | null;

  constructor(message: string, kind: AiApiErrorKind, status: number | null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AiApiError';
    this.kind = kind;
    this.status = status;
  }
}

/** Claude answered, but not with usable structured output (cut off, malformed, empty). */
export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiResponseError';
  }
}

let cached: { apiKey: string; client: Anthropic } | null = null;
let testClient: Anthropic | null = null;

function buildClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: MAX_RETRIES,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/** Cached client; rebuilt when the key changes. Throws AiNotConfiguredError without a key. */
export async function getAnthropic(): Promise<Anthropic> {
  if (testClient) return testClient;
  const apiKey = await getSecret('anthropicApiKey');
  if (!apiKey) throw new AiNotConfiguredError();
  if (cached?.apiKey !== apiKey) cached = { apiKey, client: buildClient(apiKey) };
  return cached.client;
}

/** Drop the cached client (call after the key changes). */
export function resetAnthropicClient(): void {
  cached = null;
}

/** Test-only: every call uses `client` (e.g. an Anthropic instance with a fake `fetch`); null restores. */
export function setAnthropicClientForTests(client: Anthropic | null): void {
  testClient = client;
}

/** The model id from Settings (falls back to DEFAULT_MODEL when blank). */
export async function resolveModel(): Promise<string> {
  const { model } = await getSettings();
  return model?.trim() || DEFAULT_MODEL;
}

interface RefusalLike {
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
}

/** Throws AiRefusalError when the whole fallback chain declined. Call before reading `content`. */
export function assertNotRefused(message: RefusalLike, task: string): void {
  if (message.stop_reason !== 'refusal') return;
  const category = message.stop_details?.category ?? null;
  const detail = category ? ` (${category})` : '';
  throw new AiRefusalError(`Claude declined to ${task}${detail}.`, category);
}

/** Maps SDK errors to AiApiError with a message fit for the UI; other errors pass through. */
export function toAiError(e: unknown, model: string): unknown {
  if (!(e instanceof Anthropic.APIError)) return e;
  const status = typeof e.status === 'number' ? e.status : null;
  const [kind, message] = classifyApiError(e, model);
  return new AiApiError(message, kind, status, e);
}

function classifyApiError(e: InstanceType<typeof Anthropic.APIError>, model: string): [AiApiErrorKind, string] {
  if (e instanceof Anthropic.APIUserAbortError) return ['aborted', 'Claude request cancelled.'];
  if (e instanceof Anthropic.APIConnectionTimeoutError) return ['timeout', 'Claude took too long to answer — try again later.'];
  if (e instanceof Anthropic.APIConnectionError) return ['network', "Couldn't reach Claude — check your internet connection."];
  if (e instanceof Anthropic.AuthenticationError) return ['auth', 'Claude API key rejected — check it in Settings.'];
  if (e instanceof Anthropic.PermissionDeniedError) {
    return ['permission', `This Claude API key isn't allowed to use ${model} — check your Anthropic Console.`];
  }
  if (e instanceof Anthropic.NotFoundError) return ['not_found', `Claude model "${model}" was not found — check the model id in Settings.`];
  if (e instanceof Anthropic.RateLimitError) return ['rate_limit', 'Claude rate limit reached — the rest will be processed on the next run.'];
  if (e instanceof Anthropic.BadRequestError) return ['bad_request', `Claude rejected the request: ${e.message}`];
  if (e.status === 529 || e instanceof Anthropic.InternalServerError) {
    return ['overloaded', 'Claude is temporarily unavailable — the rest will be processed on the next run.'];
  }
  return ['other', `Claude API error${e.status ? ` ${e.status}` : ''}: ${e.message}`];
}

/**
 * Cheap connectivity/auth check used by Settings → "Test Claude key". Retrieves the configured
 * model's metadata (no tokens billed), which checks the key, the network and the model id at once.
 * Pass `apiKey` to test a key before saving it.
 */
export async function testAnthropicKey(apiKey?: string): Promise<{ ok: boolean; message: string }> {
  const model = await resolveModel();
  try {
    const client = apiKey?.trim() ? buildClient(apiKey.trim()) : await getAnthropic();
    const info = await client.models.retrieve(model);
    return { ok: true, message: `Connected — ${info.display_name || model} is available.` };
  } catch (e) {
    return { ok: false, message: keyTestMessage(e, model) };
  }
}

function keyTestMessage(e: unknown, model: string): string {
  if (e instanceof AiNotConfiguredError) return 'No Claude API key saved yet.';
  const mapped = toAiError(e, model);
  if (!(mapped instanceof AiApiError)) return errorMessage(e);
  switch (mapped.kind) {
    case 'auth':
      return 'Claude API key rejected — check that you copied the whole key (it starts with "sk-ant-").';
    case 'not_found':
      return `The key works, but model "${model}" was not found — check the model id in Settings.`;
    default:
      return mapped.message;
  }
}
