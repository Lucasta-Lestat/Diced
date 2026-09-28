/// <reference types="jest" />
import * as SecureStore from 'expo-secure-store';
import { kvGet, kvSet } from '../../db/database';
import {
  __resetSettingsForTests,
  DEFAULT_SETTINGS,
  getSecret,
  getSettings,
  sanitizeOverrides,
  secretKey,
  setSecret,
  subscribeSettings,
  updateSettings,
} from '../settings';

jest.mock('../../db/database', () => ({
  kvGet: jest.fn(),
  kvSet: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 0,
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockKvGet = kvGet as jest.MockedFunction<typeof kvGet>;
const mockKvSet = kvSet as jest.MockedFunction<typeof kvSet>;
const store = SecureStore as jest.Mocked<typeof SecureStore>;

let kv: Record<string, unknown>;

beforeEach(() => {
  __resetSettingsForTests();
  jest.clearAllMocks();
  kv = {};
  mockKvGet.mockImplementation(async (key: string) => (key in kv ? structuredClone(kv[key]) : null) as never);
  mockKvSet.mockImplementation(async (key: string, value: unknown) => {
    kv[key] = structuredClone(value);
  });
});

describe('settings', () => {
  it('returns defaults when nothing is stored and loads kv only once', async () => {
    const [a, b] = await Promise.all([getSettings(), getSettings()]);
    expect(a).toEqual(DEFAULT_SETTINGS);
    expect(b).toBe(a);
    await getSettings();
    expect(mockKvGet).toHaveBeenCalledTimes(1);
    expect(mockKvGet).toHaveBeenCalledWith('settings');
  });

  it('merges stored values over defaults and drops unknown keys', async () => {
    kv.settings = { person: 'Her', scheduleHour: 7, legacyThing: true };
    const s = await getSettings();
    expect(s.person).toBe('Her');
    expect(s.scheduleHour).toBe(7);
    expect(s.model).toBe(DEFAULT_SETTINGS.model);
    expect('legacyThing' in s).toBe(false);
  });

  it('persists only explicit overrides, updates the cache and notifies subscribers', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSettings((s) => seen.push(String(s.person)));

    const next = await updateSettings({ person: 'Him', sheetWebAppUrl: 'https://x/exec' });
    expect(next.person).toBe('Him');
    expect(kv.settings).toEqual({ person: 'Him', sheetWebAppUrl: 'https://x/exec' });
    expect(await getSettings()).toBe(next);
    expect(seen).toEqual(['Him']);

    unsubscribe();
    await updateSettings({ person: 'Her' });
    expect(seen).toEqual(['Him']);
    expect(kv.settings).toEqual({ person: 'Her', sheetWebAppUrl: 'https://x/exec' });
  });

  it('serializes concurrent updates so no patch is lost', async () => {
    await Promise.all([
      updateSettings({ scheduleHour: 6 }),
      updateSettings({ scheduleMinute: 30 }),
      updateSettings({ processDaily: false }),
    ]);
    const s = await getSettings();
    expect(s).toMatchObject({ scheduleHour: 6, scheduleMinute: 30, processDaily: false });
    expect(kv.settings).toEqual({ scheduleHour: 6, scheduleMinute: 30, processDaily: false });
  });

  it('a throwing listener does not break updates', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = jest.fn();
    subscribeSettings(() => {
      throw new Error('bad listener');
    });
    subscribeSettings(good);
    await expect(updateSettings({ scaleUnit: 'kg' })).resolves.toMatchObject({ scaleUnit: 'kg' });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('a failed write leaves the cache unchanged and later updates still run', async () => {
    mockKvSet.mockRejectedValueOnce(new Error('disk full'));
    await expect(updateSettings({ scheduleHour: 5 })).rejects.toThrow('disk full');
    expect((await getSettings()).scheduleHour).toBe(DEFAULT_SETTINGS.scheduleHour);
    await expect(updateSettings({ scheduleHour: 6 })).resolves.toMatchObject({ scheduleHour: 6 });
  });

  it('sanitizeOverrides ignores non-objects and undefined values', () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides('x')).toEqual({});
    expect(sanitizeOverrides({ person: undefined, model: 'm' })).toEqual({ model: 'm' });
  });
});

describe('secrets', () => {
  it('uses SecureStore-safe keys', () => {
    for (const name of ['anthropicApiKey', 'sheetToken', 'usdaApiKey'] as const) {
      expect(secretKey(name)).toMatch(/^[A-Za-z0-9._-]+$/);
    }
    expect(secretKey('sheetToken')).toBe('diced.sheetToken');
  });

  it('reads secrets, mapping empty to null', async () => {
    store.getItemAsync.mockResolvedValueOnce('sk-test');
    expect(await getSecret('anthropicApiKey')).toBe('sk-test');
    expect(store.getItemAsync).toHaveBeenCalledWith('diced.anthropicApiKey', expect.any(Object));

    store.getItemAsync.mockResolvedValueOnce('');
    expect(await getSecret('usdaApiKey')).toBeNull();
    store.getItemAsync.mockResolvedValueOnce(null);
    expect(await getSecret('usdaApiKey')).toBeNull();
  });

  it('stores trimmed values readable after first unlock (background runs)', async () => {
    await setSecret('sheetToken', '  tok123\n');
    expect(store.setItemAsync).toHaveBeenCalledWith('diced.sheetToken', 'tok123', {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    expect(store.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('deletes on null or blank', async () => {
    await setSecret('anthropicApiKey', null);
    await setSecret('usdaApiKey', '   ');
    expect(store.deleteItemAsync).toHaveBeenCalledWith('diced.anthropicApiKey', expect.any(Object));
    expect(store.deleteItemAsync).toHaveBeenCalledWith('diced.usdaApiKey', expect.any(Object));
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });
});
