/// <reference types="jest" />
import {
  dayLabel,
  flagText,
  formatClock,
  formatInt,
  formatKcal,
  formatKcalWithRange,
  formatMacros,
  formatWeight,
  formatWeightDelta,
  joinList,
  kcalPlusMinus,
  kgToLb,
  plural,
  relativeTime,
  runSummary,
  slotText,
  statusText,
  syncSummary,
  weekdayName,
  weekdayShort,
} from '../format';

describe('numbers', () => {
  it('groups thousands without depending on the locale', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(999.4)).toBe('999');
    expect(formatInt(1234.5)).toBe('1,235');
    expect(formatInt(1234567)).toBe('1,234,567');
    expect(formatInt(-2500)).toBe('−2,500');
    expect(formatInt(Number.NaN)).toBe('—');
  });

  it('formats calories and ranges', () => {
    expect(formatKcal(652.4)).toBe('652 kcal');
    expect(formatKcal(null)).toBe('—');
    expect(kcalPlusMinus(500, 740)).toBe('±120');
    expect(kcalPlusMinus(600, 600)).toBeNull();
    expect(formatKcalWithRange(620, 500, 740)).toBe('620 kcal ±120');
    expect(formatKcalWithRange(620, null, null)).toBe('620 kcal');
  });

  it('formats macros', () => {
    expect(formatMacros({ proteinG: 32.4, carbsG: 45, fatG: 18.6 })).toBe('P 32 g · C 45 g · F 19 g');
  });
});

describe('weights', () => {
  it('shows lb with one decimal and converts to kg', () => {
    expect(formatWeight(182.44)).toBe('182.4 lb');
    expect(formatWeight(180)).toBe('180.0 lb');
    expect(formatWeight(220.462, 'kg')).toBe('100.0 kg');
    expect(formatWeight(null)).toBe('—');
    expect(kgToLb(100)).toBeCloseTo(220.462, 3);
  });

  it('signs deltas', () => {
    expect(formatWeightDelta(0.44)).toBe('+0.4 lb');
    expect(formatWeightDelta(-1.25)).toBe('−1.2 lb');
    expect(formatWeightDelta(0)).toBe('0.0 lb');
  });
});

describe('dates and times', () => {
  it('labels today and yesterday', () => {
    expect(dayLabel('2026-09-28', '2026-09-28')).toBe('Today');
    expect(dayLabel('2026-09-27', '2026-09-28')).toBe('Yesterday');
    expect(dayLabel('2026-09-26', '2026-09-28')).toBe('Sat, Sep 26');
  });

  it('formats clock and weekdays (ISO numbering)', () => {
    expect(formatClock(9, 5)).toBe('09:05');
    expect(weekdayName(1)).toBe('Monday');
    expect(weekdayName(7)).toBe('Sunday');
    expect(weekdayShort(3)).toBe('Wed');
  });

  it('describes relative times', () => {
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    expect(relativeTime(now - 30_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(relativeTime(new Date(2026, 8, 1, 12).getTime(), now)).toBe('Tue, Sep 1');
  });
});

describe('labels', () => {
  it('turns review flags into sentences', () => {
    expect(flagText('differs_from_trend')).toBe('Differs from your recent trend');
    expect(flagText('multiple_readings')).toBe('Several readings that day');
    expect(flagText('some_new_flag')).toBe('Some new flag');
  });

  it('names statuses and slots', () => {
    expect(statusText('synced')).toBe('In the sheet');
    expect(statusText('sync_error')).toBe('Sync failed');
    expect(slotText('breakfast')).toBe('Breakfast');
  });

  it('pluralizes', () => {
    expect(plural(1, 'meal')).toBe('1 meal');
    expect(plural(3, 'meal')).toBe('3 meals');
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('summaries', () => {
  const base = { weightEntriesCreated: 0, mealsCreated: 0, photosScanned: 40, partial: false, errors: [] as string[] };

  it('summarises a processing run', () => {
    expect(runSummary({ ...base, weightEntriesCreated: 3, mealsCreated: 8 })).toBe('Found 3 weigh-ins and 8 meals');
    expect(runSummary(base)).toBe('No new weigh-ins or meals in 40 photos');
    expect(runSummary({ ...base, mealsCreated: 1, partial: true, errors: ['x'] })).toBe(
      'Found 1 meal (the rest continues next run, 1 error)',
    );
  });

  it('summarises a sync', () => {
    expect(syncSummary({ weightsSynced: 2, mealsSynced: 5, deletesSynced: 0, errors: [] })).toBe('Synced 2 weigh-ins, 5 meals');
    expect(syncSummary({ weightsSynced: 0, mealsSynced: 0, deletesSynced: 0, errors: [] })).toBe('Everything is already in the sheet');
    expect(syncSummary({ weightsSynced: 0, mealsSynced: 1, deletesSynced: 1, errors: ['a', 'b'] })).toBe('Synced 1 meal, 1 removal · 2 errors');
  });
});

describe('joinList', () => {
  it('joins names for a sentence', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['rice'])).toBe('rice');
    expect(joinList(['rice', 'chicken'])).toBe('rice and chicken');
    expect(joinList(['rice', 'chicken', 'beans'])).toBe('rice, chicken and beans');
  });
});
