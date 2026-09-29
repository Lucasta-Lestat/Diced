/// <reference types="jest" />
import {
  autoRunBannerShown,
  FOREGROUND_SYNC_MIN_GAP_MS,
  isProcessWeekLink,
  progressLine,
  screenRunsPipeline,
  shouldForegroundSync,
  wantsWeeklyReminder,
} from '../autoRunPolicy';

describe('shouldForegroundSync', () => {
  const now = 1_000_000_000;

  it('always syncs right after processing', () => {
    expect(shouldForegroundSync(now - 1_000, now, true)).toBe(true);
  });

  it('throttles repeated app openings', () => {
    expect(shouldForegroundSync(now - 60_000, now, false)).toBe(false);
    expect(shouldForegroundSync(now - FOREGROUND_SYNC_MIN_GAP_MS, now, false)).toBe(true);
    expect(shouldForegroundSync(0, now, false)).toBe(true);
  });

  it('syncs when the clock went backwards', () => {
    expect(shouldForegroundSync(now + 60_000, now, false)).toBe(true);
  });
});

describe('progressLine', () => {
  it('describes the stage and count', () => {
    expect(progressLine(null)).toBe('Starting…');
    expect(progressLine({ stage: 'estimating_meals', done: 3, total: 8, message: '' })).toBe('Estimating meals · 3/8');
    expect(progressLine({ stage: 'scanning', done: 0, total: 0, message: '' })).toBe('Looking through your photos');
  });
});

describe('screenRunsPipeline', () => {
  it('recognises the process-week screen', () => {
    expect(screenRunsPipeline('/process-week')).toBe(true);
    expect(screenRunsPipeline('/review')).toBe(false);
  });
});

describe('autoRunBannerShown', () => {
  it('shows the banner only when there is something to say, off the process-week screen', () => {
    expect(autoRunBannerShown({ phase: 'idle' }, '/')).toBe(false);
    expect(autoRunBannerShown({ phase: 'processing', progress: null, hidden: false }, '/review/meal/1')).toBe(true);
    expect(autoRunBannerShown({ phase: 'processing', progress: null, hidden: false }, '/process-week')).toBe(false);
    expect(autoRunBannerShown({ phase: 'done', message: 'x', hasNew: true }, '/')).toBe(true);
    expect(autoRunBannerShown({ phase: 'error', message: 'x' }, '/settings')).toBe(true);
  });

  it('hides a processing banner the user dismissed', () => {
    expect(autoRunBannerShown({ phase: 'processing', progress: null, hidden: true }, '/review/meal/1')).toBe(false);
  });
});

describe('isProcessWeekLink', () => {
  it('recognises the Shortcuts / reminder link in its variants', () => {
    expect(isProcessWeekLink('diced://process-week')).toBe(true);
    expect(isProcessWeekLink('diced:///process-week/')).toBe(true);
    expect(isProcessWeekLink('diced://process-week?reason=manual')).toBe(true);
    expect(isProcessWeekLink('diced://review')).toBe(false);
    expect(isProcessWeekLink('diced://process-weekly')).toBe(false);
    expect(isProcessWeekLink('https://example.com/process-week')).toBe(false);
  });
});

describe('wantsWeeklyReminder', () => {
  it('only reminds when photos are read automatically', () => {
    expect(wantsWeeklyReminder({ classificationMode: 'cloud_thumbnails' })).toBe(true);
    expect(wantsWeeklyReminder({ classificationMode: 'manual' })).toBe(false);
  });
});
