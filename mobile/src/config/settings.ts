/**
 * App settings (non-secret, SQLite `kv` table under key `settings`) and secrets
 * (expo-secure-store). OWNER: data-layer builder.
 */
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

/** Current settings merged over DEFAULT_SETTINGS (cached in memory after first load). */
export async function getSettings(): Promise<AppSettings> {
  throw new Error('not implemented');
}

/** Shallow-merge `patch`, persist, notify subscribers, return the new settings. */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  throw new Error('not implemented');
}

/** Subscribe to settings changes; returns an unsubscribe function. */
export function subscribeSettings(listener: (s: AppSettings) => void): () => void {
  throw new Error('not implemented');
}

/** Read a secret from SecureStore (null when unset). Never log the value. */
export async function getSecret(name: SecretName): Promise<string | null> {
  throw new Error('not implemented');
}

/** Store (or, with null/empty, delete) a secret in SecureStore. */
export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  throw new Error('not implemented');
}
