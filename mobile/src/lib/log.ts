/**
 * Tiny logger. Never pass secrets (API keys, sheet token) or image data to it.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, message: string, extra?: unknown) {
  if (level === 'debug' && !__DEV__) return;
  const line = `[diced:${scope}] ${message}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) fn(line);
  else fn(line, extra);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

/** Human-readable message from an unknown error value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
