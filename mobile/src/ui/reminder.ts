/** Keeps the weekly reminder in line with the settings (native: expo-notifications). */
import { cancelWeeklyReminder, scheduleWeeklyReminder } from '../scheduling/notifications';
import type { AppSettings } from '../types';
import { wantsWeeklyReminder } from './autoRunPolicy';

/**
 * Schedules the weekly "log your week" reminder, or removes it in manual mode, where a run reads
 * no photos. Throws when scheduling fails (e.g. notifications are off).
 */
export async function armWeeklyReminder(settings: AppSettings): Promise<void> {
  if (wantsWeeklyReminder(settings)) await scheduleWeeklyReminder(settings);
  else await cancelWeeklyReminder();
}
