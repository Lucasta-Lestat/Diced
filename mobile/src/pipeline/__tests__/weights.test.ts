/// <reference types="jest" />
import type { Confidence, WeightCandidate, WeightEntry, WeightUnit } from '../../types';
import {
  attachCandidates,
  buildWeightEntries,
  chooseReading,
  trendBaseline,
  type BuildWeightOptions,
} from '../weights';

// Local wall-clock times (Sep 2026), so the tests hold in any time zone.
const at = (d: number, h: number, min = 0) => new Date(2026, 8, d, h, min).getTime();
const NOW = at(30, 12);

function cand(
  assetId: string,
  takenAt: number,
  valueLb: number,
  readConfidence: Confidence = 'high',
  rawUnit: WeightUnit = 'lb',
): WeightCandidate {
  return { assetId, takenAt, valueLb, rawValue: rawUnit === 'kg' ? Math.round((valueLb / 2.20462) * 10) / 10 : valueLb, rawUnit, readConfidence };
}

function opts(patch: Partial<BuildWeightOptions> = {}): BuildWeightOptions {
  return { morningCutoffHour: 11, recent: [], now: NOW, ...patch };
}

function entry(patch: Partial<WeightEntry>): WeightEntry {
  return {
    id: 'w:Her:2026-09-28',
    person: 'Her',
    localDate: '2026-09-28',
    time: '07:00',
    valueLb: 185,
    chosenAssetId: 'old',
    source: 'photo',
    confidence: 'high',
    candidates: [cand('old', at(28, 7), 185)],
    flags: [],
    notes: 'after run',
    status: 'needs_review',
    syncError: null,
    updatedAt: 1,
    ...patch,
  };
}

const build = (candidates: WeightCandidate[], existing: WeightEntry[] = [], o: Partial<BuildWeightOptions> = {}) =>
  buildWeightEntries('Her', candidates, existing, opts(o));

describe('buildWeightEntries — choosing the official reading', () => {
  it('creates one needs_review entry per day from the earliest morning reading', () => {
    const [e] = build([cand('b', at(28, 7, 30), 184.8), cand('a', at(28, 6, 45), 184.6), cand('c', at(28, 20), 186.9)]);
    expect(e).toEqual({
      id: 'w:Her:2026-09-28',
      person: 'Her',
      localDate: '2026-09-28',
      time: '06:45',
      valueLb: 184.6,
      chosenAssetId: 'a',
      source: 'photo',
      confidence: 'high',
      candidates: [cand('a', at(28, 6, 45), 184.6), cand('b', at(28, 7, 30), 184.8), cand('c', at(28, 20), 186.9)],
      flags: [],
      notes: '',
      status: 'needs_review',
      syncError: null,
      updatedAt: NOW,
    });
  });

  it('prefers a morning reading over an earlier-in-the-list evening one', () => {
    const [e] = build([cand('evening', at(28, 19), 186), cand('morning', at(28, 8), 184)]);
    expect(e.chosenAssetId).toBe('morning');
  });

  it('falls back to the earliest reading of the day and flags not_morning', () => {
    const [e] = build([cand('late', at(28, 18), 185.5), cand('noon', at(28, 12), 185.1)], [], {});
    expect(e.chosenAssetId).toBe('noon');
    expect(e.time).toBe('12:00');
    expect(e.flags).toEqual(['not_morning']);
  });

  it('respects the configured morning cutoff', () => {
    const [e] = build([cand('a', at(28, 9, 30), 185)], [], { morningCutoffHour: 9 });
    expect(e.flags).toContain('not_morning');
  });

  it('takes a clearer retake within 10 minutes of the first reading', () => {
    const readings = [cand('blurry', at(28, 7), 188.1, 'low'), cand('retake', at(28, 7, 2), 185.1, 'high')];
    const [e] = build(readings);
    expect(e.chosenAssetId).toBe('retake');
    expect(e.flags).toEqual(['multiple_readings']);
    // A clearer photo 30 minutes later is a different weigh-in.
    expect(chooseReading([cand('blurry', at(28, 7), 188.1, 'low'), cand('later', at(28, 7, 30), 185.1)], 11)?.assetId).toBe('blurry');
  });

  it('computes one entry per day, sorted by date', () => {
    const entries = build([cand('b', at(29, 7), 184.5), cand('a', at(28, 7), 185)]);
    expect(entries.map((e) => e.id)).toEqual(['w:Her:2026-09-28', 'w:Her:2026-09-29']);
  });

  it('marks quick-log captures as source capture', () => {
    const [e] = build([cand('capture:123', at(28, 7), 185)]);
    expect(e.source).toBe('capture');
  });

  it('skips a misread implausible value when a plausible one exists, else flags it', () => {
    const [ok] = build([cand('misread', at(28, 6), 18.5), cand('good', at(28, 6, 30), 185)]);
    expect(ok.chosenAssetId).toBe('good');
    expect(ok.flags).toEqual([]);

    const [bad] = build([cand('misread', at(28, 6), 18.5)]);
    expect(bad.valueLb).toBe(18.5);
    expect(bad.flags).toContain('implausible_value');
    expect(bad.confidence).toBe('low');
  });

  it('ignores unusable candidates and days without any', () => {
    expect(build([cand('nan', at(28, 7), Number.NaN), cand('zero', at(28, 7), 0)])).toEqual([]);
    expect(build([])).toEqual([]);
  });
});

describe('buildWeightEntries — flags and confidence', () => {
  it('flags multiple_readings when the morning readings spread more than 0.6 lb', () => {
    expect(build([cand('a', at(28, 6), 185), cand('b', at(28, 7), 185.6)])[0].flags).toEqual([]);
    expect(build([cand('a', at(28, 6), 184.4), cand('b', at(28, 7), 185)])[0].flags).toEqual([]);
    expect(build([cand('a', at(28, 6), 185), cand('b', at(28, 7), 185.7)])[0].flags).toEqual(['multiple_readings']);
  });

  it('does not compare a morning weigh-in with an evening one', () => {
    expect(build([cand('am', at(28, 7), 185), cand('pm', at(28, 21), 188)])[0].flags).toEqual([]);
  });

  it('flags a low read confidence and lowers confidence', () => {
    const [e] = build([cand('a', at(28, 7), 185, 'low')]);
    expect(e.flags).toEqual(['low_read_confidence']);
    expect(e.confidence).toBe('low');
    expect(build([cand('a', at(28, 7), 185, 'medium')])[0].confidence).toBe('medium');
  });

  it('checks the trend against the median of the last 7 accepted days (> 4 lb)', () => {
    const recent = [
      { localDate: '2026-09-27', valueLb: 186 },
      { localDate: '2026-09-26', valueLb: 185 },
      { localDate: '2026-09-25', valueLb: 199 }, // one outlier doesn't move the median
    ];
    const ok = build([cand('a', at(28, 7), 189.9)], [], { recent });
    expect(ok[0].flags).toEqual([]);
    expect(ok[0].confidence).toBe('high');

    const off = build([cand('a', at(28, 7), 190.1)], [], { recent });
    expect(off[0].flags).toEqual(['differs_from_trend']);
    expect(off[0].confidence).toBe('low');
  });

  it('uses 2.5 % of the baseline for lighter people', () => {
    const recent = [{ localDate: '2026-09-27', valueLb: 120 }];
    expect(build([cand('a', at(28, 7), 122.9)], [], { recent })[0].flags).toEqual([]);
    expect(build([cand('a', at(28, 7), 123.1)], [], { recent })[0].flags).toEqual(['differs_from_trend']);
  });

  it('skips the trend check without history', () => {
    const [e] = build([cand('a', at(28, 7), 250)]);
    expect(e.flags).toEqual([]);
    expect(e.confidence).toBe('high');
  });

  it('only uses history before the day and at most 7 accepted days', () => {
    const recent = [
      { localDate: '2026-09-29', valueLb: 150 }, // after the day: ignored
      ...Array.from({ length: 7 }, (_, i) => ({ localDate: `2026-09-${String(27 - i).padStart(2, '0')}`, valueLb: 185 })),
      { localDate: '2026-09-10', valueLb: 150 }, // 8th day back: ignored
      { localDate: '2026-09-09', valueLb: 150 },
    ];
    expect(trendBaseline(recent, '2026-09-28')).toBe(185);
    expect(trendBaseline([], '2026-09-28')).toBeNull();
  });

  it('counts accepted entries in the window as history for later days', () => {
    const approved = entry({ id: 'w:Her:2026-09-27', localDate: '2026-09-27', valueLb: 185, status: 'approved' });
    const [e] = build([cand('a', at(28, 7), 195)], [approved]);
    expect(e.flags).toEqual(['differs_from_trend']);
  });

  it('flags readings converted from kg unless the scale is set to kg', () => {
    const kg = cand('a', at(28, 7), 185.2, 'high', 'kg');
    expect(build([kg])[0].flags).toEqual(['unit_converted']);
    expect(build([kg], [], { expectedUnit: 'kg' })[0].flags).toEqual([]);
  });
});

describe('buildWeightEntries — existing entries', () => {
  it('merges new readings into a needs_review entry and keeps its notes', () => {
    const existing = entry({ candidates: [cand('old', at(28, 7), 185)] });
    const [e] = build([cand('new', at(28, 6, 30), 184.2)], [existing]);
    expect(e.candidates.map((c) => c.assetId)).toEqual(['new', 'old']);
    expect(e.chosenAssetId).toBe('new');
    expect(e.valueLb).toBe(184.2);
    expect(e.notes).toBe('after run');
    expect(e.flags).toEqual(['multiple_readings']);
    expect(e.updatedAt).toBe(NOW);
  });

  it('replaces an earlier reading of the same photo', () => {
    const existing = entry({ candidates: [cand('old', at(28, 7), 158)] });
    const [e] = build([cand('old', at(28, 7), 185)], [existing]);
    expect(e.candidates).toHaveLength(1);
    expect(e.valueLb).toBe(185);
  });

  it.each(['approved', 'synced', 'sync_error'] as const)('never overwrites a %s entry', (status) => {
    const existing = entry({ status, valueLb: 185 });
    const entries = build([cand('new', at(28, 6), 180)], [existing]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(existing);
  });

  it('starts a rejected day over from the new readings', () => {
    const existing = entry({ status: 'rejected' });
    const [e] = build([cand('new', at(28, 8), 184.9)], [existing]);
    expect(e.status).toBe('needs_review');
    expect(e.candidates.map((c) => c.assetId)).toEqual(['new']);
  });

  it('ignores existing entries of other days', () => {
    const other = entry({ id: 'w:Her:2026-09-27', localDate: '2026-09-27', status: 'needs_review' });
    const entries = build([cand('a', at(28, 7), 185)], [other]);
    expect(entries.map((e) => e.id)).toEqual(['w:Her:2026-09-28']);
  });
});

describe('attachCandidates', () => {
  it('adds new same-day readings without touching value, status or updatedAt', () => {
    const synced = entry({ status: 'synced', updatedAt: 5 });
    const out = attachCandidates(synced, [cand('late', at(28, 20), 187), cand('other-day', at(29, 7), 184), cand('old', at(28, 7), 185)]);
    expect(out.candidates.map((c) => c.assetId)).toEqual(['old', 'late']);
    expect(out).toMatchObject({ status: 'synced', valueLb: 185, updatedAt: 5 });
  });

  it('returns the same entry when nothing is new', () => {
    const e = entry({});
    expect(attachCandidates(e, [cand('old', at(28, 7), 185)])).toBe(e);
  });
});
