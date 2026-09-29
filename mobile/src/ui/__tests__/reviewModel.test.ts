/// <reference types="jest" />
import type { MealEntry, MealEstimate, WeightEntry } from '../../types';
import {
  averageLb,
  countConfident,
  dayKcal,
  groupByDay,
  isConfidentMeal,
  isConfidentWeight,
  mergeCandidates,
  scaledKcal,
  splitAssumptions,
  summaryNeedsRefresh,
  unansweredQuestions,
  weekWeighIns,
} from '../reviewModel';

function weight(patch: Partial<WeightEntry>): WeightEntry {
  const localDate = patch.localDate ?? '2026-09-28';
  return {
    id: `w:Her:${localDate}`,
    person: 'Her',
    localDate,
    time: '07:10',
    valueLb: 182.4,
    chosenAssetId: 'a1',
    source: 'photo',
    confidence: 'high',
    candidates: [],
    flags: [],
    notes: '',
    status: 'needs_review',
    syncError: null,
    updatedAt: 1,
    ...patch,
  };
}

function estimate(patch: Partial<MealEstimate> = {}): MealEstimate {
  return {
    title: 'Oats',
    items: [],
    totals: { kcal: 400, proteinG: 15, carbsG: 60, fatG: 10 },
    kcalLow: 350,
    kcalHigh: 450,
    confidence: 'high',
    method: 'photo',
    questions: [],
    assumptions: [],
    libraryItemId: null,
    brand: null,
    barcode: null,
    model: 'claude-opus-5-5',
    samples: 1,
    createdAt: 1,
    ...patch,
  };
}

function meal(patch: Partial<MealEntry>): MealEntry {
  return {
    id: patch.id ?? 'm1',
    person: 'Her',
    localDate: '2026-09-28',
    time: '08:00',
    slot: 'breakfast',
    assetIds: ['p1'],
    estimate: estimate(),
    final: { kcal: 400, proteinG: 15, carbsG: 60, fatG: 10 },
    title: 'Oats',
    answers: {},
    notes: '',
    status: 'needs_review',
    error: null,
    updatedAt: 1,
    ...patch,
  };
}

const question = { id: 'q1', question: 'Milk?', options: ['None', 'Skim', 'Whole'], affects: ['oats'] };

describe('groupByDay', () => {
  it('puts days newest first and meals in time order', () => {
    const days = groupByDay(
      [weight({ localDate: '2026-09-27' }), weight({ localDate: '2026-09-28' })],
      [
        meal({ id: 'dinner', localDate: '2026-09-27', time: '19:00' }),
        meal({ id: 'breakfast', localDate: '2026-09-27', time: '08:00' }),
        meal({ id: 'late', localDate: '2026-09-29', time: '22:00' }),
      ],
    );
    expect(days.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-28', '2026-09-27']);
    expect(days[2].meals.map((m) => m.id)).toEqual(['breakfast', 'dinner']);
    expect(days[1].weights).toHaveLength(1);
    expect(days[0].weights).toHaveLength(0);
  });
});

describe('confidence', () => {
  it('matches the approve-all-confident rule for weights', () => {
    expect(isConfidentWeight(weight({}))).toBe(true);
    expect(isConfidentWeight(weight({ flags: ['not_morning'] }))).toBe(false);
    expect(isConfidentWeight(weight({ confidence: 'medium' }))).toBe(false);
    expect(isConfidentWeight(weight({ valueLb: null }))).toBe(false);
    expect(isConfidentWeight(weight({ status: 'approved' }))).toBe(false);
  });

  it('needs open questions answered for meals', () => {
    const asked = meal({ estimate: estimate({ questions: [question] }) });
    expect(isConfidentMeal(asked)).toBe(false);
    expect(unansweredQuestions(asked)).toHaveLength(1);
    const answered = { ...asked, answers: { q1: 'Skim' } };
    expect(unansweredQuestions(answered)).toHaveLength(0);
    expect(isConfidentMeal(answered)).toBe(true);
    expect(isConfidentMeal(meal({ estimate: null }))).toBe(false);
    expect(isConfidentMeal(meal({ error: 'failed' }))).toBe(false);
    expect(countConfident([weight({})], [asked, answered])).toBe(2);
  });

  it('counts exactly what approve-all approves (portion checks, implausible weights excluded)', () => {
    const flagged = meal({ estimate: estimate({ assumptions: ['check_portion:white rice'] }) });
    expect(isConfidentMeal(flagged)).toBe(false);
    expect(isConfidentWeight(weight({ valueLb: 18.5 }))).toBe(false);
    expect(countConfident([weight({ valueLb: 18.5 })], [flagged])).toBe(0);
  });
});

describe('totals', () => {
  it('sums the day without rejected meals', () => {
    const meals = [
      meal({ id: 'a', final: { kcal: 400, proteinG: 0, carbsG: 0, fatG: 0 } }),
      meal({ id: 'b', final: { kcal: 600, proteinG: 0, carbsG: 0, fatG: 0 }, status: 'synced' }),
      meal({ id: 'c', final: { kcal: 900, proteinG: 0, carbsG: 0, fatG: 0 }, status: 'rejected' }),
      meal({ id: 'd', localDate: '2026-09-27', final: { kcal: 300, proteinG: 0, carbsG: 0, fatG: 0 } }),
    ];
    expect(dayKcal(meals, '2026-09-28')).toBe(1000);
  });

  it('lays out the ISO week and averages its daily values', () => {
    // 2026-09-30 is a Wednesday.
    const days = weekWeighIns(
      [
        weight({ localDate: '2026-09-28', valueLb: 182 }),
        weight({ localDate: '2026-09-29', valueLb: 181, status: 'rejected' }),
        weight({ localDate: '2026-09-30', valueLb: 181.5, status: 'synced' }),
        weight({ localDate: '2026-09-27', valueLb: 190 }),
      ],
      '2026-09-30',
    );
    expect(days.map((d) => d.date)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(days[1].entry).toBeNull();
    expect(averageLb(days)).toBe(181.8);
    expect(averageLb(days.map((d) => ({ ...d, entry: null })))).toBeNull();
  });
});

describe('mergeCandidates', () => {
  it('offers other meals that day, earlier and closer first', () => {
    const current = meal({ id: 'x', time: '13:00' });
    const sameDay = [
      current,
      meal({ id: 'breakfast', time: '08:00' }),
      meal({ id: 'lunch', time: '12:40' }),
      meal({ id: 'dinner', time: '19:00' }),
      meal({ id: 'gone', time: '12:50', status: 'rejected' }),
      meal({ id: 'other-day', time: '12:55', localDate: '2026-09-27' }),
    ];
    expect(mergeCandidates(current, sameDay).map((m) => m.id)).toEqual(['lunch', 'breakfast', 'dinner']);
  });
});

describe('scaledKcal', () => {
  it('scales calories with grams', () => {
    expect(scaledKcal(248, 150, 200)).toBe(331);
    expect(scaledKcal(248, null, 200)).toBeNull();
    expect(scaledKcal(248, 0, 200)).toBeNull();
  });
});

describe('splitAssumptions', () => {
  it('turns check_portion tokens into flagged item names and keeps the rest as notes', () => {
    expect(
      splitAssumptions(['Cooked in 1 tbsp oil', 'check_portion:white rice', 'Portion from a 10 in plate', 'check_portion:white rice', 'check_portion: chicken ']),
    ).toEqual({ notes: ['Cooked in 1 tbsp oil', 'Portion from a 10 in plate'], checkPortions: ['white rice', 'chicken'] });
    expect(splitAssumptions([])).toEqual({ notes: [], checkPortions: [] });
  });
});

describe('summaryNeedsRefresh', () => {
  const HOUR = 60 * 60_000;
  // Wednesday 2026-09-30 12:00 local
  const wed = new Date(2026, 8, 30, 12, 0, 0).getTime();

  it('refreshes when missing or older than the limit', () => {
    expect(summaryNeedsRefresh(null, wed, HOUR)).toBe(true);
    expect(summaryNeedsRefresh(wed - 2 * HOUR, wed, HOUR)).toBe(true);
    expect(summaryNeedsRefresh(wed - 10 * 60_000, wed, HOUR)).toBe(false);
  });

  it('refreshes once a new plan week has started, however recent the copy is', () => {
    const sundayNight = new Date(2026, 9, 4, 23, 50, 0).getTime();
    const mondayMorning = new Date(2026, 9, 5, 0, 5, 0).getTime();
    expect(summaryNeedsRefresh(sundayNight, mondayMorning, HOUR)).toBe(true);
    expect(summaryNeedsRefresh(mondayMorning, mondayMorning + 10 * 60_000, HOUR)).toBe(false);
  });

  it('refreshes when the clock went backwards', () => {
    expect(summaryNeedsRefresh(wed + HOUR, wed, HOUR)).toBe(true);
  });
});
