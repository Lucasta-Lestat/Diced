/// <reference types="jest" />
import * as Notifications from 'expo-notifications';
import type { AppSettings } from '../../types';
import { notificationLink, reviewReadyMessage, toExpoWeekday, weeklyTriggerParts } from '../notificationContent';
import * as notifications from '../notifications';

jest.mock('react-native', () => {
  const rn = jest.requireActual('react-native');
  rn.Platform.OS = 'android';
  return rn;
});

jest.mock('expo-notifications', () => {
  let responseListener: ((r: unknown) => void) | null = null;
  return {
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    AndroidImportance: { DEFAULT: 5 },
    IosAuthorizationStatus: { PROVISIONAL: 3 },
    SchedulableTriggerInputTypes: { WEEKLY: 'weekly' },
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async () => null),
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    scheduleNotificationAsync: jest.fn(async () => 'id'),
    cancelScheduledNotificationAsync: jest.fn(async () => undefined),
    getLastNotificationResponse: jest.fn(() => null),
    clearLastNotificationResponse: jest.fn(),
    addNotificationResponseReceivedListener: jest.fn((listener: (r: unknown) => void) => {
      responseListener = listener;
      return { remove: jest.fn(() => (responseListener = null)) };
    }),
    __emitResponse: (r: unknown) => responseListener?.(r),
  };
});

const N = jest.mocked(Notifications);
const emitResponse = (Notifications as unknown as { __emitResponse: (r: unknown) => void }).__emitResponse;

function response(url: unknown, identifier = 'n1', date = 1000, action = Notifications.DEFAULT_ACTION_IDENTIFIER) {
  return {
    actionIdentifier: action,
    notification: { date, request: { identifier, content: { data: url === undefined ? {} : { url } } } },
  } as unknown as Notifications.NotificationResponse;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  notifications.__resetNotificationsForTests();
  N.getLastNotificationResponse.mockReturnValue(null);
});

describe('toExpoWeekday', () => {
  it('converts ISO weekdays (1 = Monday) to expo weekdays (1 = Sunday)', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(toExpoWeekday)).toEqual([2, 3, 4, 5, 6, 7, 1]);
  });

  it('clamps invalid input into range', () => {
    expect(toExpoWeekday(0)).toBe(2);
    expect(toExpoWeekday(12)).toBe(1);
    expect(toExpoWeekday(Number.NaN)).toBe(2);
  });
});

describe('weeklyTriggerParts', () => {
  it('maps the schedule to trigger components', () => {
    expect(weeklyTriggerParts({ scheduleWeekday: 7, scheduleHour: 20, scheduleMinute: 30 })).toEqual({
      weekday: 1,
      hour: 20,
      minute: 30,
    });
  });
});

describe('reviewReadyMessage', () => {
  it('describes both counts', () => {
    expect(reviewReadyMessage(3, 12)).toBe('3 weigh-ins and 12 meals ready to review');
  });

  it('uses singular forms and omits zero counts', () => {
    expect(reviewReadyMessage(1, 0)).toBe('1 weigh-in ready to review');
    expect(reviewReadyMessage(0, 1)).toBe('1 meal ready to review');
  });

  it('returns null when there is nothing to review', () => {
    expect(reviewReadyMessage(0, 0)).toBeNull();
    expect(reviewReadyMessage(-1, Number.NaN)).toBeNull();
  });
});

describe('notificationLink', () => {
  it('accepts only diced:// links', () => {
    expect(notificationLink({ url: 'diced://review' })).toBe('diced://review');
    expect(notificationLink({ url: 'https://evil.example' })).toBeNull();
    expect(notificationLink({ url: 42 })).toBeNull();
    expect(notificationLink(null)).toBeNull();
  });
});

describe('scheduleWeeklyReminder', () => {
  it('replaces the previous reminder and converts the weekday', async () => {
    const { scheduleWeeklyReminder, WEEKLY_REMINDER_ID } = notifications;
    await scheduleWeeklyReminder({ scheduleWeekday: 1, scheduleHour: 9, scheduleMinute: 5 } as AppSettings);

    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith(WEEKLY_REMINDER_ID);
    expect(N.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: WEEKLY_REMINDER_ID,
        content: expect.objectContaining({ data: { url: 'diced://process-week' } }),
        trigger: { type: 'weekly', weekday: 2, hour: 9, minute: 5, channelId: 'diced-default' },
      }),
    );
    expect(N.cancelScheduledNotificationAsync.mock.invocationCallOrder[0]).toBeLessThan(
      N.scheduleNotificationAsync.mock.invocationCallOrder[0],
    );
  });
});

describe('configureNotifications', () => {
  it('sets the foreground handler once and creates the Android channel', async () => {
    const { configureNotifications } = notifications;
    await configureNotifications();
    await configureNotifications();

    expect(N.setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = N.setNotificationHandler.mock.calls[0][0]!;
    await expect(handler.handleNotification({} as Notifications.Notification)).resolves.toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
    });
    expect(N.setNotificationChannelAsync).toHaveBeenCalledWith('diced-default', expect.objectContaining({ importance: 5 }));
  });
});

describe('requestNotificationPermission', () => {
  it('returns true without prompting when already granted', async () => {
    N.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true } as never);
    await expect(notifications.requestNotificationPermission()).resolves.toBe(true);
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does not prompt when the user can no longer be asked', async () => {
    N.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false } as never);
    await expect(notifications.requestNotificationPermission()).resolves.toBe(false);
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('prompts and reports the result', async () => {
    N.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true } as never);
    N.requestPermissionsAsync.mockResolvedValue({ granted: true } as never);
    await expect(notifications.requestNotificationPermission()).resolves.toBe(true);
  });
});

describe('notifyReviewReady', () => {
  it('skips when there is nothing new', async () => {
    await notifications.notifyReviewReady(0, 0);
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('posts an immediate notification that opens the review queue', async () => {
    await notifications.notifyReviewReady(3, 12);
    expect(N.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'diced-review-ready',
      content: { title: 'Ready to review', body: '3 weigh-ins and 12 meals ready to review', data: { url: 'diced://review' } },
      trigger: { channelId: 'diced-default' },
    });
  });

  it('drops an identical notification posted right after (pipeline + background task)', async () => {
    const { notifyReviewReady } = notifications;
    await notifyReviewReady(2, 1);
    await notifyReviewReady(2, 1);
    await notifyReviewReady(2, 2);
    expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
  });
});

describe('listenForNotificationLinks', () => {
  it('opens the link of the notification that launched the app', async () => {
    N.getLastNotificationResponse.mockReturnValue(response('diced://process-week'));
    const onUrl = jest.fn();
    notifications.listenForNotificationLinks(onUrl);
    await flush();
    expect(onUrl).toHaveBeenCalledWith('diced://process-week');
    expect(N.clearLastNotificationResponse).toHaveBeenCalled();
  });

  it('handles taps while running and ignores foreign or non-tap responses', () => {
    const onUrl = jest.fn();
    notifications.listenForNotificationLinks(onUrl);
    emitResponse(response('diced://review', 'a'));
    emitResponse(response('https://example.com', 'b'));
    emitResponse(response(undefined, 'c'));
    emitResponse(response('diced://review', 'd', 1000, 'some.custom.action'));
    expect(onUrl.mock.calls).toEqual([['diced://review']]);
  });

  it('does not report the launching tap twice', async () => {
    const launching = response('diced://review', 'same', 42);
    N.getLastNotificationResponse.mockReturnValue(launching);
    const onUrl = jest.fn();
    notifications.listenForNotificationLinks(onUrl);
    emitResponse(launching);
    await flush();
    expect(onUrl).toHaveBeenCalledTimes(1);
  });

  it('stops after unsubscribe, including a pending cold-start response', async () => {
    N.getLastNotificationResponse.mockReturnValue(response('diced://review'));
    const onUrl = jest.fn();
    const unsubscribe = notifications.listenForNotificationLinks(onUrl);
    unsubscribe();
    await flush();
    emitResponse(response('diced://review', 'later'));
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('survives getLastNotificationResponse being unavailable', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    N.getLastNotificationResponse.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(() => notifications.listenForNotificationLinks(jest.fn())).not.toThrow();
  });
});
