/// <reference types="jest" />
import type { AppSettings } from '../../types';
import {
  DAILY_RUN_GAP_MS,
  isDailyRunDue,
  isWeeklyRunDue,
  nextScanWindow,
  nextWeeklySlot,
  previousWeeklySlot,
  shiftLocalDays,
} from '../due';

// Expectations are built with the local Date constructor, so these hold in any time zone
// (run e.g. `TZ=America/New_York npx jest src/scheduling` or `TZ=Australia/Lord_Howe …`).
const at = (y: number, month: number, d: number, h = 0, min = 0) => new Date(y, month - 1, d, h, min).getTime();

const BASE: AppSettings = {
  person: 'Her',
  sheetWebAppUrl: 'https://script.google.com/macros/s/abc/exec',
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
  onboardingComplete: true,
};

const settings = (patch: Partial<AppSettings> = {}): AppSettings => ({ ...BASE, ...patch });

// 2026-09-28 is a Monday.
describe('nextWeeklySlot', () => {
  it('returns later the same day when the slot is still ahead', () => {
    expect(nextWeeklySlot(settings(), at(2026, 9, 28, 8, 0))).toBe(at(2026, 9, 28, 9, 0));
  });

  it('moves to next week once the slot has passed', () => {
    expect(nextWeeklySlot(settings(), at(2026, 9, 28, 10, 0))).toBe(at(2026, 10, 5, 9, 0));
  });

  it('is strictly after now', () => {
    expect(nextWeeklySlot(settings(), at(2026, 9, 28, 9, 0))).toBe(at(2026, 10, 5, 9, 0));
  });

  it('crosses the week boundary from Sunday to a Monday slot', () => {
    expect(nextWeeklySlot(settings(), at(2026, 10, 4, 23, 30))).toBe(at(2026, 10, 5, 9, 0));
  });

  it('finds a Sunday slot later in the same ISO week', () => {
    const s = settings({ scheduleWeekday: 7, scheduleHour: 20, scheduleMinute: 15 });
    expect(nextWeeklySlot(s, at(2026, 9, 28, 8, 0))).toBe(at(2026, 10, 4, 20, 15));
  });

  it('keeps the wall-clock time across DST changes', () => {
    const s = settings({ scheduleWeekday: 7, scheduleHour: 9 });
    // US fall-back is Sun 2026-11-01, EU fall-back Sun 2026-10-25, US spring-forward Sun 2026-03-08.
    expect(nextWeeklySlot(s, at(2026, 10, 31, 12, 0))).toBe(at(2026, 11, 1, 9, 0));
    expect(nextWeeklySlot(s, at(2026, 10, 20, 12, 0))).toBe(at(2026, 10, 25, 9, 0));
    expect(nextWeeklySlot(s, at(2026, 3, 2, 12, 0))).toBe(at(2026, 3, 8, 9, 0));
  });

  it('crosses a year boundary', () => {
    const s = settings({ scheduleWeekday: 5, scheduleHour: 7 });
    // Fri 2027-01-01
    expect(nextWeeklySlot(s, at(2026, 12, 31, 18, 0))).toBe(at(2027, 1, 1, 7, 0));
  });
});

describe('previousWeeklySlot', () => {
  it('returns earlier the same day when the slot has passed', () => {
    expect(previousWeeklySlot(settings(), at(2026, 9, 28, 10, 0))).toBe(at(2026, 9, 28, 9, 0));
  });

  it('includes a slot exactly at now', () => {
    expect(previousWeeklySlot(settings(), at(2026, 9, 28, 9, 0))).toBe(at(2026, 9, 28, 9, 0));
  });

  it('goes back a week when today’s slot is still ahead', () => {
    expect(previousWeeklySlot(settings(), at(2026, 9, 28, 8, 59))).toBe(at(2026, 9, 21, 9, 0));
  });

  it('goes back across the week boundary for a Sunday slot', () => {
    const s = settings({ scheduleWeekday: 7, scheduleHour: 20 });
    expect(previousWeeklySlot(s, at(2026, 9, 30, 12, 0))).toBe(at(2026, 9, 27, 20, 0));
  });

  it('clamps out-of-range settings instead of producing nonsense', () => {
    const s = settings({ scheduleWeekday: 9, scheduleHour: 30, scheduleMinute: -5 });
    // weekday 7 (Sunday), 23:00
    expect(previousWeeklySlot(s, at(2026, 9, 30, 12, 0))).toBe(at(2026, 9, 27, 23, 0));
  });
});

describe('isWeeklyRunDue', () => {
  const now = at(2026, 9, 28, 10, 0);

  it('is due on the first run', () => {
    expect(isWeeklyRunDue(settings({ lastAutoRunAt: null }), now)).toBe(true);
  });

  it('is due when the slot passed after the last automatic run', () => {
    expect(isWeeklyRunDue(settings({ lastAutoRunAt: at(2026, 9, 27, 9, 0) }), now)).toBe(true);
  });

  it('is not due when the last run happened after the slot', () => {
    expect(isWeeklyRunDue(settings({ lastAutoRunAt: at(2026, 9, 28, 9, 30) }), now)).toBe(false);
  });

  it('is not due before today’s slot if last week’s slot was handled', () => {
    expect(isWeeklyRunDue(settings({ lastAutoRunAt: at(2026, 9, 21, 9, 5) }), at(2026, 9, 28, 8, 0))).toBe(false);
  });

  it('treats a last run in the future (clock changed) as due', () => {
    expect(isWeeklyRunDue(settings({ lastAutoRunAt: at(2026, 12, 1) }), now)).toBe(true);
  });
});

describe('isDailyRunDue', () => {
  const now = at(2026, 9, 28, 10, 0);

  it('is never due when daily processing is off', () => {
    expect(isDailyRunDue(settings({ processDaily: false, lastAutoRunAt: null }), now)).toBe(false);
  });

  it('is due when there was no automatic run yet', () => {
    expect(isDailyRunDue(settings({ lastAutoRunAt: null }), now)).toBe(true);
  });

  it('is not due within 20 hours of the last run', () => {
    expect(isDailyRunDue(settings({ lastAutoRunAt: now - DAILY_RUN_GAP_MS + 60_000 }), now)).toBe(false);
  });

  it('is due 20 hours after the last run', () => {
    expect(isDailyRunDue(settings({ lastAutoRunAt: now - DAILY_RUN_GAP_MS }), now)).toBe(true);
  });
});

describe('nextScanWindow', () => {
  const now = at(2026, 9, 28, 10, 0);

  it('looks back 8 calendar days on the first run', () => {
    expect(nextScanWindow(settings({ lastScanEnd: null }), now)).toEqual({
      startMs: at(2026, 9, 20, 10, 0),
      endMs: now,
    });
  });

  it('continues from the end of the last scan', () => {
    const lastScanEnd = at(2026, 9, 21, 9, 3);
    expect(nextScanWindow(settings({ lastScanEnd }), now)).toEqual({ startMs: lastScanEnd, endMs: now });
  });

  it('caps the window at 35 days', () => {
    expect(nextScanWindow(settings({ lastScanEnd: at(2026, 6, 1) }), now)).toEqual({
      startMs: at(2026, 8, 24, 10, 0),
      endMs: now,
    });
  });

  it('keeps a window of exactly 35 days', () => {
    const lastScanEnd = at(2026, 8, 24, 10, 0);
    expect(nextScanWindow(settings({ lastScanEnd }), now).startMs).toBe(lastScanEnd);
  });

  it('never returns an inverted window when lastScanEnd is in the future', () => {
    expect(nextScanWindow(settings({ lastScanEnd: at(2026, 10, 3) }), now)).toEqual({ startMs: now, endMs: now });
  });
});

describe('shiftLocalDays', () => {
  it('keeps the local wall-clock time across month and DST boundaries', () => {
    expect(shiftLocalDays(at(2026, 11, 3, 7, 45), -8)).toBe(at(2026, 10, 26, 7, 45));
    expect(shiftLocalDays(at(2026, 3, 1, 23, 0), 10)).toBe(at(2026, 3, 11, 23, 0));
  });
});
