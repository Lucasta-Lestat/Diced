/**
 * Typed client for the Apps Script web app (docs/SHEET_SCHEMA.md). OWNER: data-layer builder.
 * POST text/plain JSON; follows the Apps Script 302 redirect; 30 s timeout; maps
 * `{ok:false}` to SheetsApiError.
 */
import type { ActionMap, ActionName, ErrorCode } from './contract';

export class SheetsApiError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode | 'network' | 'not_configured' | 'bad_response',
  ) {
    super(message);
    this.name = 'SheetsApiError';
  }
}

export class SheetsClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async call<A extends ActionName>(action: A, payload: ActionMap[A]['payload']): Promise<ActionMap[A]['data']> {
    throw new Error('not implemented');
  }
}

/** Client from settings + secrets; throws SheetsApiError('not_configured') if URL/token missing. */
export async function getSheetsClient(): Promise<SheetsClient> {
  throw new Error('not implemented');
}
