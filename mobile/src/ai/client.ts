/**
 * Anthropic client for React Native. OWNER: AI builder.
 * - API key from SecureStore (`anthropicApiKey`); `dangerouslyAllowBrowser: true` (RN looks
 *   browser-like to the SDK; the key is the user's own and stays on their device).
 * - All calls use `client.beta.messages.parse/create` with `betas: ['server-side-fallback-2026-07-01']`
 *   and `fallbacks: 'default'`, and handle `stop_reason === 'refusal'`.
 */
import type Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AiNotConfiguredError extends Error {}
export class AiRefusalError extends Error {}

/** Cached client; rebuilt when the key changes. Throws AiNotConfiguredError without a key. */
export async function getAnthropic(): Promise<Anthropic> {
  throw new Error('not implemented');
}

/** Drop the cached client (call after the key changes). */
export function resetAnthropicClient(): void {
  throw new Error('not implemented');
}

/** Cheap connectivity/auth check used by Settings → "Test Claude key". */
export async function testAnthropicKey(): Promise<{ ok: boolean; message: string }> {
  throw new Error('not implemented');
}
