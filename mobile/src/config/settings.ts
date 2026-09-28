/**
 * App settings (non-secret, SQLite `kv` table under key `settings`) and secrets
 * (expo-secure-store). OWNER: data-layer builder.
 */
import * as SecureStore from 'expo-secure-store';
import { kvGet, kvSet } from '../db/database';
import { logger } from '../lib/log';
import type { AppSettings, SecretName } from '../types';

export const DEFAULT_SETTINGS: AppSettings = {
  person: null,
  sheetWebAppUrl: null,
  scheduleWeekday: 1,
  scheduleHour: 9,
  scheduleMinute: 0,
  processDaily: true,
  classificationMode: 'cloud_thumbnails',
  accuracyMode: 'standard',
  webLookupForRestaurants: true,
  plateDiameterIn: null,
  scaleUnit: 'lb',
  mealGroupingMinutes: 20,
  morningCutoffHour: 11,
  model: 'claude-opus-5-5',
  lastScanEnd: null,
  lastAutoRunAt: null,
  onboardingComplete: false,
};

const SETTINGS_KEY = 'settings';
const log = logger('settings');

/**
 * Only the values that were explicitly set are persisted, so a changed default in a
 * later app version still reaches users who never touched that setting.
 */
let overrides: Partial<AppSettings> | null = null;
let cache: AppSettings | null = null;
let loading: Promise<AppSettings> | null = null;
let writeChain: Promise<unknown> = Promise.resolve();
const listeners = new Set<(s: AppSettings) => void>();

/** Keeps known keys with defined values (drops stale keys from older app versions). */
export function sanitizeOverrides(raw: unknown): Partial<AppSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key in DEFAULT_SETTINGS && value !== undefined) out[key] = value;
  }
  return out as Partial<AppSettings>;
}

function merged(o: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...o };
}

async function load(): Promise<AppSettings> {
  overrides = sanitizeOverrides(await kvGet<Partial<AppSettings>>(SETTINGS_KEY));
  cache = merged(overrides);
  return cache;
}

/** Current settings merged over DEFAULT_SETTINGS (cached in memory after first load). */
export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache;
  if (!loading) {
    loading = load().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/** Shallow-merge `patch`, persist, notify subscribers, return the new settings. */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // Serialized so two concurrent patches can't overwrite each other's keys.
  const run = async (): Promise<AppSettings> => {
    await getSettings();
    const nextOverrides = { ...overrides, ...sanitizeOverrides(patch) };
    await kvSet(SETTINGS_KEY, nextOverrides);
    overrides = nextOverrides;
    cache = merged(nextOverrides);
    notify(cache);
    return cache;
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

function notify(settings: AppSettings): void {
  for (const listener of [...listeners]) {
    try {
      listener(settings);
    } catch (e) {
      log.warn('settings listener threw', e);
    }
  }
}

/** Subscribe to settings changes; returns an unsubscribe function. */
export function subscribeSettings(listener: (s: AppSettings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** SecureStore keys may only contain alphanumerics, `.`, `-` and `_`. */
export function secretKey(name: SecretName): string {
  return `diced.${name}`;
}

/**
 * AFTER_FIRST_UNLOCK so the background task can still read the keys while the phone
 * is locked (the default WHEN_UNLOCKED would make background runs fail on iOS).
 */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** Read a secret from SecureStore (null when unset). Never log the value. */
export async function getSecret(name: SecretName): Promise<string | null> {
  const value = await SecureStore.getItemAsync(secretKey(name), SECURE_OPTIONS);
  return value ? value : null;
}

/** Store (or, with null/empty, delete) a secret in SecureStore. Surrounding whitespace is trimmed. */
export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    await SecureStore.deleteItemAsync(secretKey(name), SECURE_OPTIONS);
    return;
  }
  await SecureStore.setItemAsync(secretKey(name), trimmed, SECURE_OPTIONS);
}

/** Test-only: drop the in-memory cache and listeners. */
export function __resetSettingsForTests(): void {
  overrides = null;
  cache = null;
  loading = null;
  writeChain = Promise.resolve();
  listeners.clear();
}
