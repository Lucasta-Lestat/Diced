/// <reference types="jest" />
import { FOREGROUND_SYNC_MIN_GAP_MS, progressLine, screenRunsPipeline, shouldForegroundSync } from '../autoRunPolicy';

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
