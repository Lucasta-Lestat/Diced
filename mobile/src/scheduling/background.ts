/**
 * Background processing via expo-background-task + expo-task-manager. OWNER: photos/scheduling builder.
 * `defineBackgroundTask()` must run at module scope of the app entry (called from src/app/_layout.tsx).
 */

export const BACKGROUND_TASK = 'diced-background-processing';

/** TaskManager.defineTask for BACKGROUND_TASK: if weekly/daily run is due → processPhotos with a time budget → notify. */
export function defineBackgroundTask(): void {
  throw new Error('not implemented');
}

/** Register (idempotent) with a minimum interval of 12 h. No-op when unavailable (e.g. Expo Go/web). */
export async function registerBackgroundTask(): Promise<void> {
  throw new Error('not implemented');
}

export async function unregisterBackgroundTask(): Promise<void> {
  throw new Error('not implemented');
}

export async function backgroundTaskStatus(): Promise<'available' | 'restricted' | 'unavailable'> {
  throw new Error('not implemented');
}
