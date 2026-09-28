/**
 * Thorough mode: combine independent estimates of the same meal. OWNER: AI builder. Pure.
 */
import type { FoodItem, Macros, MealEstimate } from '../types';
import { confidenceRank, lowerConfidence, minConfidence, roundMacros, saneRange } from './schemas';

/** Estimates further apart than this (relative to their mean) lower confidence one level. */
export const DISAGREEMENT_SHARE = 0.2;

function meanMacros(samples: MealEstimate[]): Macros {
  const n = samples.length;
  const sum = (pick: (m: Macros) => number) => samples.reduce((acc, s) => acc + pick(s.totals), 0) / n;
  return roundMacros({
    kcal: sum((m) => m.kcal),
    proteinG: sum((m) => m.proteinG),
    carbsG: sum((m) => m.carbsG),
    fatG: sum((m) => m.fatG),
  });
}

/** Closest total to the mean; ties (always the case with two samples) → higher confidence, then narrower range. */
function pickRepresentative(samples: MealEstimate[], meanKcal: number): MealEstimate {
  const score = (s: MealEstimate) => [
    Math.abs(s.totals.kcal - meanKcal),
    -confidenceRank(s.confidence),
    s.kcalHigh - s.kcalLow,
  ];
  return samples.reduce((best, s) => {
    const [a, b] = [score(s), score(best)];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? s : best;
    }
    return best;
  });
}

function scaleMacros(m: Macros, k: number): Macros {
  return roundMacros({ kcal: m.kcal * k, proteinG: m.proteinG * k, carbsG: m.carbsG * k, fatG: m.fatG * k });
}

/**
 * Items keep the representative's breakdown but are scaled to the mean total, so that later
 * steps which recompute totals from items (reconcile) keep the averaged portion.
 */
function scaleItems(items: FoodItem[], k: number): FoodItem[] {
  if (!Number.isFinite(k) || Math.abs(k - 1) < 0.005) return items;
  return items.map((item) => ({
    ...item,
    grams: item.grams === null ? null : Math.round(item.grams * k),
    macros: scaleMacros(item.macros, k),
    modelMacros: item.modelMacros ? scaleMacros(item.modelMacros, k) : null,
  }));
}

/**
 * Merge N ≥ 1 estimates: items from the sample closest to the mean (scaled to it), totals = mean,
 * kcal range = union, confidence = the lowest sample's, lowered one more level when the totals
 * differ by more than 20 %. Samples that found no food are dropped (and force low confidence) as
 * long as at least one sample found food.
 */
export function mergeSamples(samples: MealEstimate[]): MealEstimate {
  if (samples.length === 0) throw new Error('mergeSamples needs at least one estimate');
  const n = samples.length;
  const withFood = samples.filter((s) => s.items.length > 0);
  if (n === 1 || withFood.length === 0) return { ...samples[0], samples: n };

  const mean = meanMacros(withFood);
  const rep = pickRepresentative(withFood, mean.kcal);
  const kcals = withFood.map((s) => s.totals.kcal);
  const spread = mean.kcal > 0 ? (Math.max(...kcals) - Math.min(...kcals)) / mean.kcal : 0;
  const disagree = spread > DISAGREEMENT_SHARE;

  let confidence = withFood.map((s) => s.confidence).reduce(minConfidence);
  if (disagree) confidence = lowerConfidence(confidence);
  if (withFood.length < n) confidence = 'low';

  const range = saneRange(
    Math.min(...withFood.map((s) => s.kcalLow)),
    Math.max(...withFood.map((s) => s.kcalHigh)),
    mean.kcal,
  );

  const notes: string[] = [];
  if (withFood.length > 1) notes.push(`Average of ${withFood.length} independent estimates (${kcals.join(' / ')} kcal).`);
  if (disagree) notes.push(`The estimates differed by ${Math.round(spread * 100)}% — check the portions.`);
  if (withFood.length < n) notes.push(`${n - withFood.length} of ${n} independent estimates found no food in these photos.`);

  return {
    ...rep,
    items: scaleItems(rep.items, rep.totals.kcal > 0 ? mean.kcal / rep.totals.kcal : 1),
    totals: mean,
    ...range,
    confidence,
    assumptions: [...rep.assumptions, ...notes],
    brand: rep.brand ?? withFood.find((s) => s.brand)?.brand ?? null,
    barcode: rep.barcode ?? withFood.find((s) => s.barcode)?.barcode ?? null,
    samples: n,
  };
}
