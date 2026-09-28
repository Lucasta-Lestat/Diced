/// <reference types="jest" />
import { getSecret, getSettings } from '../../config/settings';
import { DEFAULT_SETTINGS } from '../../config/settings';
import { kvGet, kvSet } from '../../db/database';
import type { PingData } from '../contract';
import {
  getSheetInfo,
  getSheetsClient,
  pingSheet,
  refreshSheetInfo,
  SheetsApiError,
  SheetsClient,
  SHEETS_TIMEOUT_MS,
} from '../sheetsClient';

jest.mock('../../config/settings', () => ({
  DEFAULT_SETTINGS: jest.requireActual('../../config/settings').DEFAULT_SETTINGS,
  getSettings: jest.fn(),
  getSecret: jest.fn(),
}));
jest.mock('../../db/database', () => ({ kvGet: jest.fn(), kvSet: jest.fn() }));

const URL = 'https://script.google.com/macros/s/abc/exec';
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>;
const mockGetSecret = getSecret as jest.MockedFunction<typeof getSecret>;
const mockKvGet = kvGet as jest.MockedFunction<typeof kvGet>;
const mockKvSet = kvSet as jest.MockedFunction<typeof kvSet>;

const PING: PingData = {
  version: '1.0.0',
  schemaVersion: 1,
  spreadsheetName: 'Road to Feb 27',
  timezone: 'America/New_York',
  people: ['Her', 'Him'],
  startDate: '2026-09-28',
  eventDate: '2027-02-27',
};

let fetchMock: jest.Mock;

function reply(status: number, body: string) {
  fetchMock.mockResolvedValueOnce({ status, text: async () => body });
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, sheetWebAppUrl: URL });
  mockGetSecret.mockResolvedValue('tok');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('SheetsClient.call', () => {
  it('POSTs text/plain JSON {token, action, payload}, follows redirects and returns data', async () => {
    reply(200, JSON.stringify({ ok: true, data: { inserted: 1, updated: 2 } }));
    const client = new SheetsClient(URL, 'secret-token');
    const data = await client.call('upsertWeights', { entries: [] });
    expect(data).toEqual({ inserted: 1, updated: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
    });
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body)).toEqual({ token: 'secret-token', action: 'upsertWeights', payload: { entries: [] } });
  });

  it('maps {ok:false} to SheetsApiError with the server code', async () => {
    reply(200, JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'Row 3: weightLb out of range' } }));
    const err = await new SheetsClient(URL, 't').call('upsertWeights', { entries: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(SheetsApiError);
    expect(err).toMatchObject({ code: 'bad_request', message: 'Row 3: weightLb out of range' });
  });

  it('explains an unauthorized token and treats unknown codes as internal', async () => {
    reply(200, JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Bad token' } }));
    await expect(new SheetsClient(URL, 't').call('ping', {})).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('Show app connection info'),
    });
    reply(200, JSON.stringify({ ok: false, error: { code: 'weird' } }));
    await expect(new SheetsClient(URL, 't').call('ping', {})).rejects.toMatchObject({ code: 'internal' });
  });

  it('turns a Google sign-in page into bad_response with a deployment hint', async () => {
    reply(
      200,
      '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head>' +
        '<body><form action="https://accounts.google.com/ServiceLogin"></form></body></html>',
    );
    const err = await new SheetsClient(URL, 't').call('ping', {}).catch((e) => e);
    expect(err).toBeInstanceOf(SheetsApiError);
    expect(err.code).toBe('bad_response');
    expect(err.message).toContain('Who has access: Anyone');
    expect(err.message).toContain('Sign in - Google Accounts');
    expect(err.message).not.toContain('"t"');
  });

  it('handles other HTML error pages and 404s', async () => {
    reply(200, '<html><body>Script function not found: doPost</body></html>');
    await expect(new SheetsClient(URL, 't').call('ping', {})).rejects.toMatchObject({
      code: 'bad_response',
      message: expect.stringContaining('doPost'),
    });
    reply(404, '<html><head><title>Not Found</title></head></html>');
    await expect(new SheetsClient(URL, 't').call('ping', {})).rejects.toMatchObject({
      code: 'bad_response',
      message: expect.stringContaining('/exec'),
    });
  });

  it('rejects bodies that are not JSON or not the Diced envelope', async () => {
    reply(502, 'Bad Gateway');
    await expect(new SheetsClient(URL, 't').call('ping', {})).rejects.toMatchObject({
      code: 'bad_response',
      message: expect.stringContaining('HTTP 502'),
    });
    reply(200, JSON.stringify({ hello: 'world' }));
    await expect(new SheetsClient(URL, 't').call('ping', {})).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('maps fetch failures to network errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(new SheetsClient(URL, 't').call('ping', {})).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('Network request failed'),
    });
  });

  it('aborts after 30 s', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );
    const pending = new SheetsClient(URL, 't').call('ping', {});
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('30 s'),
    });
    await jest.advanceTimersByTimeAsync(SHEETS_TIMEOUT_MS - 1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe('getSheetsClient', () => {
  it('throws not_configured without URL or token', async () => {
    mockGetSettings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, sheetWebAppUrl: null });
    await expect(getSheetsClient()).rejects.toMatchObject({ code: 'not_configured' });
    mockGetSecret.mockResolvedValueOnce(null);
    await expect(getSheetsClient()).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-https URLs', async () => {
    mockGetSettings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, sheetWebAppUrl: 'http://example.com/exec' });
    await expect(getSheetsClient()).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('builds a client from settings + the sheetToken secret', async () => {
    reply(200, JSON.stringify({ ok: true, data: PING }));
    const client = await getSheetsClient();
    await client.call('ping', {});
    expect(mockGetSecret).toHaveBeenCalledWith('sheetToken');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('tok');
  });
});

describe('pingSheet / sheet info', () => {
  it('pings an explicit URL + token without settings', async () => {
    reply(200, JSON.stringify({ ok: true, data: PING }));
    expect(await pingSheet(` ${URL} `, ' tok2 ')).toEqual(PING);
    expect(fetchMock.mock.calls[0][0]).toBe(URL);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: 'tok2', action: 'ping', payload: {} });
    expect(mockGetSettings).not.toHaveBeenCalled();
    await expect(pingSheet(URL, ' ')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('refreshSheetInfo caches the ping in kv; getSheetInfo ignores info for another URL', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1234);
    reply(200, JSON.stringify({ ok: true, data: PING }));
    const info = await refreshSheetInfo();
    expect(info).toEqual({ ...PING, url: URL, fetchedAt: 1234 });
    expect(mockKvSet).toHaveBeenCalledWith('sheetInfo', info);

    mockKvGet.mockResolvedValue(info as never);
    expect(await getSheetInfo()).toEqual(info);
    mockGetSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, sheetWebAppUrl: 'https://other/exec' });
    expect(await getSheetInfo()).toBeNull();
  });
});
