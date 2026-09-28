/** Minimal JSON GET with a timeout for the nutrition databases. OWNER: nutrition/pipeline builder. */

export const LOOKUP_TIMEOUT_MS = 10_000;

export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * GET `url` and parse JSON. Throws HttpStatusError for non-2xx (except statuses listed in
 * `okStatuses`, whose JSON body is returned), and a timeout/network error otherwise.
 * Never put the URL in an error message: it may carry an API key.
 */
export async function getJson(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; okStatuses?: number[] } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...opts.headers },
      signal: controller.signal,
    });
    if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) throw new HttpStatusError(res.status);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** A finite, non-negative number from a JSON value that may be a number or a numeric string. */
export function toAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
