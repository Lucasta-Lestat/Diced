/**
 * Local notifications (expo-notifications). OWNER: photos/scheduling builder.
 * Tapping a notification opens its `data.url` (a `diced://` deep link).
 */
import type { AppSettings } from '../types';

/** Set the foreground handler + Android channel. Call once at startup. */
export async function configureNotifications(): Promise<void> {
  throw new Error('not implemented');
}

export async function requestNotificationPermission(): Promise<boolean> {
  throw new Error('not implemented');
}

/** (Re)schedule the weekly "process your week" reminder → data.url = 'diced://process-week'. */
export async function scheduleWeeklyReminder(settings: AppSettings): Promise<void> {
  throw new Error('not implemented');
}

/** Immediate notification: "3 weigh-ins and 12 meals ready to review" → data.url = 'diced://review'. */
export async function notifyReviewReady(weights: number, meals: number): Promise<void> {
  throw new Error('not implemented');
}

/**
 * Subscribe to notification taps (including the one that launched the app) and call
 * `onUrl` with the deep link. Returns an unsubscribe function.
 */
export function listenForNotificationLinks(onUrl: (url: string) => void): () => void {
  throw new Error('not implemented');
}
