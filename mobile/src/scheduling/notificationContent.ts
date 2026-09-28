/** Pure helpers for notifications.ts (no native imports). OWNER: photos/scheduling builder. */

function clampInt(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * Our settings use ISO weekdays (1 = Monday … 7 = Sunday); expo-notifications' weekly
 * trigger uses 1 = Sunday … 7 = Saturday.
 */
export function toExpoWeekday(isoWeekday: number): number {
  return (clampInt(isoWeekday, 1, 7, 1) % 7) + 1;
}

/** Components for expo-notifications' WEEKLY trigger from our schedule settings. */
export function weeklyTriggerParts(schedule: {
  scheduleWeekday: number;
  scheduleHour: number;
  scheduleMinute: number;
}): { weekday: number; hour: number; minute: number } {
  return {
    weekday: toExpoWeekday(schedule.scheduleWeekday),
    hour: clampInt(schedule.scheduleHour, 0, 23, 9),
    minute: clampInt(schedule.scheduleMinute, 0, 59, 0),
  };
}

function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function safeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "3 weigh-ins and 12 meals ready to review", or null when there is nothing to review. */
export function reviewReadyMessage(weights: number, meals: number): string | null {
  const w = safeCount(weights);
  const m = safeCount(meals);
  const parts: string[] = [];
  if (w > 0) parts.push(countLabel(w, 'weigh-in', 'weigh-ins'));
  if (m > 0) parts.push(countLabel(m, 'meal', 'meals'));
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} ready to review`;
}

/** The deep link carried in a notification's data, if it is one of ours. */
export function notificationLink(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === 'string' && url.startsWith('diced://') ? url : null;
}
