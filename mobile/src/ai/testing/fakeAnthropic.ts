/**
 * Test helper: a real Anthropic SDK client whose `fetch` is scripted, so tests exercise the SDK's
 * own request building, structured-output parsing and typed errors without the network.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export interface FakeResponse {
  status?: number;
  body: unknown;
}

export type Responder = (req: CapturedRequest, index: number) => FakeResponse;

export function fakeFetch(responder: Responder) {
  const requests: CapturedRequest[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const req: CapturedRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    requests.push(req);
    const res = responder(req, requests.length - 1);
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': `req_${requests.length}` },
    });
  };
  return { fetch, requests };
}

export function fakeAnthropic(responder: Responder) {
  const { fetch, requests } = fakeFetch(responder);
  const client = new Anthropic({ apiKey: 'sk-ant-test', fetch, maxRetries: 0, dangerouslyAllowBrowser: true });
  return { client, requests };
}

export function messageBody(opts: {
  text?: string;
  json?: unknown;
  content?: unknown[];
  stopReason?: string;
  stopDetails?: unknown;
  model?: string;
}) {
  const text = opts.json !== undefined ? JSON.stringify(opts.json) : opts.text;
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5-5',
    content: opts.content ?? (text !== undefined ? [{ type: 'text', text }] : []),
    stop_reason: opts.stopReason ?? 'end_turn',
    stop_sequence: null,
    stop_details: opts.stopDetails ?? null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

export function errorBody(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

export const tinyImage = (tag = 'img') => ({
  base64: `BASE64-${tag}`,
  mediaType: 'image/jpeg' as const,
  width: 10,
  height: 10,
});
