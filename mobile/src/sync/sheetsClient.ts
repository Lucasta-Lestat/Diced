/**
 * Typed client for the Apps Script web app (docs/SHEET_SCHEMA.md). OWNER: data-layer builder.
 * POST text/plain JSON; follows the Apps Script 302 redirect; 30 s timeout; maps
 * `{ok:false}` to SheetsApiError.
 */
import { getSecret, getSettings } from '../config/settings';
import { kvGet, kvSet } from '../db/database';
import { errorMessage } from '../lib/log';
import type { ActionMap, ActionName, ErrorCode, PingData, RequestBody } from './contract';
import { isAppsScriptExecUrl } from './webAppUrl';

export class SheetsApiError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode | 'network' | 'not_configured' | 'bad_response',
  ) {
    super(message);
    this.name = 'SheetsApiError';
  }
}

export const SHEETS_TIMEOUT_MS = 30_000;

const ERROR_CODES: readonly ErrorCode[] = ['unauthorized', 'bad_request', 'not_found', 'internal'];

export class SheetsClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async call<A extends ActionName>(action: A, payload: ActionMap[A]['payload']): Promise<ActionMap[A]['data']> {
    const body: RequestBody<A> = { token: this.token, action, payload };
    const { status, text } = await postText(this.url, JSON.stringify(body));
    return parseResponse<A>(status, text);
  }
}

async function postText(url: string, body: string): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEETS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // text/plain keeps this a "simple" request; Apps Script can't answer a CORS preflight.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    if (controller.signal.aborted) {
      throw new SheetsApiError(
        `The sheet didn't answer within ${SHEETS_TIMEOUT_MS / 1000} s. Check your connection and try again.`,
        'network',
      );
    }
    throw new SheetsApiError(`Couldn't reach the sheet: ${errorMessage(e)}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a raw HTTP response to the action's data, or throws SheetsApiError. */
export function parseResponse<A extends ActionName>(status: number, text: string): ActionMap[A]['data'] {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) throw htmlError(status, trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SheetsApiError(
      `The sheet web app returned something that isn't JSON (HTTP ${status}). ` +
        'Check that the URL is the web-app URL ending in /exec.',
      'bad_response',
    );
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { ok?: unknown }).ok !== 'boolean') {
    throw new SheetsApiError(
      `Unexpected reply from the sheet web app (HTTP ${status}). Is this the Diced Apps Script URL?`,
      'bad_response',
    );
  }
  const body = parsed as { ok: boolean; data?: unknown; error?: { code?: unknown; message?: unknown } };
  if (!body.ok) {
    const code = ERROR_CODES.find((c) => c === body.error?.code) ?? 'internal';
    const message = typeof body.error?.message === 'string' && body.error.message ? body.error.message : code;
    throw new SheetsApiError(errorHint(code, message), code);
  }
  return body.data as ActionMap[A]['data'];
}

function errorHint(code: ErrorCode, message: string): string {
  if (code === 'unauthorized') {
    return `${message} — the app token doesn't match. Copy it again from the sheet's Diced menu → Show app connection info.`;
  }
  return message;
}

/**
 * Apps Script answers with an HTML page instead of JSON when the deployment isn't
 * public ("Who has access: Anyone") — Google's sign-in page — or on script errors.
 */
function htmlError(status: number, html: string): SheetsApiError {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const lower = html.toLowerCase();
  let hint: string;
  if (lower.includes('accounts.google.com') || lower.includes('servicelogin') || /sign in/i.test(title ?? '')) {
    hint =
      'Google asked for a sign-in. In Apps Script, deploy the web app with "Execute as: Me" and ' +
      '"Who has access: Anyone", then use the new /exec URL.';
  } else if (lower.includes('script function not found')) {
    hint = 'The deployment has no doPost. Paste the latest Code.gs and create a new deployment.';
  } else if (status === 404 || /not found/i.test(title ?? '')) {
    hint = 'The web-app URL was not found. Copy it again from Deploy → Manage deployments (it ends in /exec).';
  } else {
    hint =
      'Check the URL is the web-app URL ending in /exec and the deployment\'s access is "Anyone".';
  }
  const page = title ? ` ("${title}")` : '';
  return new SheetsApiError(`The sheet returned a web page instead of data${page}. ${hint}`, 'bad_response');
}

/**
 * The token and entries only ever go to a script.google.com web-app `/exec` URL (the same rule as
 * the sheet's own dialog, apps-script/Code.gs DICED_EXEC_URL_RE), whatever a link or paste says.
 */
function checkUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https:\/\/\S+$/i.test(trimmed)) {
    throw new SheetsApiError('The sheet URL must start with https:// (the Apps Script /exec URL).', 'not_configured');
  }
  if (!isAppsScriptExecUrl(trimmed)) {
    const dev = /^https:\/\/script\.google\.com\/\S*\/dev\/?$/i.test(trimmed);
    throw new SheetsApiError(
      dev
        ? 'This is the /dev test URL. Use the web-app URL ending in /exec (Diced → Show app connection info).'
        : 'Diced only connects to a Google Apps Script web-app URL: https://script.google.com/…/exec, ' +
            'exactly as Diced → Show app connection info in your sheet shows it.',
      'not_configured',
    );
  }
  return trimmed;
}

/** Client from settings + secrets; throws SheetsApiError('not_configured') if URL/token missing. */
export async function getSheetsClient(): Promise<SheetsClient> {
  const settings = await getSettings();
  const token = await getSecret('sheetToken');
  if (!settings.sheetWebAppUrl || !token) {
    throw new SheetsApiError('Connect the Google Sheet in Settings first (web-app URL and token).', 'not_configured');
  }
  return new SheetsClient(checkUrl(settings.sheetWebAppUrl), token);
}

/** `ping` with an explicit URL/token (onboarding / diced://connect), before anything is saved. */
export async function pingSheet(url: string, token: string): Promise<PingData> {
  if (!token.trim()) throw new SheetsApiError('The app token is empty.', 'not_configured');
  return new SheetsClient(checkUrl(url), token.trim()).call('ping', {});
}

// ---------------------------------------------------------------------------
// Cached sheet info (kv `sheetInfo`)
// ---------------------------------------------------------------------------

const SHEET_INFO_KEY = 'sheetInfo';

export interface SheetInfo extends PingData {
  /** Web-app URL the info came from (cache is ignored after the URL changes). */
  url: string;
  fetchedAt: number;
}

/** Last ping result for the currently configured sheet (no network), or null. */
export async function getSheetInfo(): Promise<SheetInfo | null> {
  const [info, settings] = await Promise.all([kvGet<SheetInfo>(SHEET_INFO_KEY), getSettings()]);
  if (!info || !settings.sheetWebAppUrl || info.url !== settings.sheetWebAppUrl.trim()) return null;
  return info;
}

/** Store a ping result (e.g. from pingSheet during onboarding) for `url`. */
export async function saveSheetInfo(url: string, data: PingData): Promise<SheetInfo> {
  const info: SheetInfo = { ...data, url: url.trim(), fetchedAt: Date.now() };
  await kvSet(SHEET_INFO_KEY, info);
  return info;
}

/** Ping the configured sheet and cache the result. */
export async function refreshSheetInfo(): Promise<SheetInfo> {
  const settings = await getSettings();
  const client = await getSheetsClient();
  const data = await client.call('ping', {});
  return saveSheetInfo(settings.sheetWebAppUrl ?? '', data);
}
