/**
 * Local-time date helpers. All "days" in the app are calendar days in the
 * device's time zone; the sheet stores plain dates, so we never send instants.
 */
import type { LocalDate, LocalTime } from '../types';

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for the local calendar day containing `ms`. */
export function toLocalDate(ms: number): LocalDate {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:mm` local wall-clock time for `ms`. */
export function toLocalTime(ms: number): LocalTime {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local hour (0-23) for `ms`. */
export function localHour(ms: number): number {
  return new Date(ms).getHours();
}

/** Midnight (local) at the start of `date`, in ms. */
export function startOfLocalDate(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** `date` shifted by `days` calendar days (DST-safe). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days, 12, 0, 0, 0);
  return toLocalDate(dt.getTime());
}

/** Whole calendar days from `a` to `b` (b - a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number);
  const js = new Date(y, m - 1, d, 12).getDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

/** Monday of the ISO week containing `date`. */
export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, 1 - isoWeekday(date));
}

/** Plan week number (1-based) of `date` given the plan start Monday; <1 before the plan. */
export function planWeek(date: LocalDate, startMonday: LocalDate): number {
  return Math.floor(daysBetween(startMonday, date) / 7) + 1;
}

export function isValidLocalDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** `Mon, Sep 28` style label for UI. */
export function formatDayLabel(date: LocalDate): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()];
  return `${wd}, ${mo} ${d}`;
}
