/**
 * Local notifications (expo-notifications). OWNER: photos/scheduling builder.
 * Tapping a notification opens its `data.url` (a `diced://` deep link).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { logger } from '../lib/log';
import type { AppSettings } from '../types';
import { notificationLink, reviewReadyMessage, weeklyTriggerParts } from './notificationContent';

export { notificationLink, reviewReadyMessage, toExpoWeekday, weeklyTriggerParts } from './notificationContent';

export const NOTIFICATION_CHANNEL_ID = 'diced-default';
/** Fixed identifiers: rescheduling replaces instead of stacking duplicates. */
export const WEEKLY_REMINDER_ID = 'diced-weekly-reminder';
export const REVIEW_READY_ID = 'diced-review-ready';
export const PROCESS_WEEK_URL = 'diced://process-week';
export const REVIEW_URL = 'diced://review';

/** The same "ready to review" text within this window is a duplicate (pipeline + background task). */
const REVIEW_READY_DEDUPE_MS = 60_000;

const log = logger('notifications');
let handlerSet = false;
let lastReviewReady: { body: string; at: number } | null = null;

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
    name: 'Diced',
    description: 'Weekly reminder and "ready to review" alerts',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/** Channel only matters on Android; iOS ignores it. */
function channelTrigger(): Notifications.NotificationTriggerInput {
  return Platform.OS === 'android' ? { channelId: NOTIFICATION_CHANNEL_ID } : null;
}

/** Set the foreground handler + Android channel. Call once at startup. */
export async function configureNotifications(): Promise<void> {
  if (!handlerSet) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    handlerSet = true;
  }
  // Android 13+ only shows the permission prompt once a channel exists.
  await ensureAndroidChannel();
}

export async function requestNotificationPermission(): Promise<boolean> {
  await ensureAndroidChannel();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return true;
  if (!current.canAskAgain) return false;
  const next = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: false, allowSound: true },
  });
  return next.granted || next.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

/** (Re)schedule the weekly "process your week" reminder → data.url = 'diced://process-week'. */
export async function scheduleWeeklyReminder(settings: AppSettings): Promise<void> {
  await ensureAndroidChannel();
  await cancelWeeklyReminder();
  await Notifications.scheduleNotificationAsync({
    identifier: WEEKLY_REMINDER_ID,
    content: {
      title: 'Log your week',
      body: 'Tap to read this week’s weigh-ins and meals from your photos.',
      data: { url: PROCESS_WEEK_URL },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      ...weeklyTriggerParts(settings),
      channelId: NOTIFICATION_CHANNEL_ID,
    },
  });
}

/** Remove the weekly reminder (e.g. when the phone is disconnected from the sheet). */
export async function cancelWeeklyReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(WEEKLY_REMINDER_ID);
  } catch (e) {
    log.warn('could not cancel weekly reminder', e);
  }
}

/** Immediate notification: "3 weigh-ins and 12 meals ready to review" → data.url = 'diced://review'. */
export async function notifyReviewReady(weights: number, meals: number): Promise<void> {
  const body = reviewReadyMessage(weights, meals);
  if (!body) return;
  const now = Date.now();
  if (lastReviewReady && lastReviewReady.body === body && now - lastReviewReady.at < REVIEW_READY_DEDUPE_MS) {
    return;
  }
  lastReviewReady = { body, at: now };
  // May run headless from the background task; Android drops notifications for a missing channel.
  await ensureAndroidChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: REVIEW_READY_ID,
    content: { title: 'Ready to review', body, data: { url: REVIEW_URL } },
    trigger: channelTrigger(),
  });
}

function responseKey(response: Notifications.NotificationResponse): string {
  return `${response.notification.request.identifier}@${response.notification.date}`;
}

/**
 * Subscribe to notification taps (including the one that launched the app) and call
 * `onUrl` with the deep link. Returns an unsubscribe function.
 */
export function listenForNotificationLinks(onUrl: (url: string) => void): () => void {
  let active = true;
  // The launching tap can be reported both as the last response and through the listener.
  const handled = new Set<string>();

  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!active || !response) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const key = responseKey(response);
    if (handled.has(key)) return;
    handled.add(key);
    const url = notificationLink(response.notification.request.content.data);
    if (!url) return;
    // So a remount (or the next launch) doesn't replay a tap that was already handled.
    try {
      Notifications.clearLastNotificationResponse();
    } catch (e) {
      log.debug('clearLastNotificationResponse failed', e);
    }
    onUrl(url);
  };

  const subscription = Notifications.addNotificationResponseReceivedListener(handle);

  let coldStart: Notifications.NotificationResponse | null = null;
  try {
    coldStart = Notifications.getLastNotificationResponse();
  } catch (e) {
    log.debug('getLastNotificationResponse unavailable', e);
  }
  // Deferred so the caller has its unsubscribe function before onUrl can navigate.
  if (coldStart) {
    const launching = coldStart;
    void Promise.resolve().then(() => handle(launching));
  }

  return () => {
    active = false;
    subscription.remove();
  };
}

/** Test-only: forget the handler flag and the last "ready to review" notification. */
export function __resetNotificationsForTests(): void {
  handlerSet = false;
  lastReviewReady = null;
}
