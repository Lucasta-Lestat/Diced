/**
 * Combine the model's itemised estimate with databases. OWNER: nutrition/pipeline builder.
 * - label / library / barcode items: keep authoritative numbers
 * - other items with grams + usdaQuery: USDA per-100g × grams; if model and USDA kcal differ
 *   by > 35 % keep the USDA number but add a `check_portion:<item>` assumption and drop
 *   confidence one level
 * - restaurant (brand set, webLookup on): published nutrition replaces the total
 * Always recomputes totals and the kcal range.
 */
import { lookupPublishedNutrition, type PublishedNutrition } from '../ai/restaurant';
import { errorMessage, logger } from '../lib/log';
import { CHECK_PORTION_PREFIX } from '../pipeline/confidence';
import { mapLimit } from '../pipeline/concurrency';
import type { Confidence, FoodItem, Macros, MealEstimate } from '../types';
import { isValidGtin, lookupBarcode, type OffProduct } from './openfoodfacts';
import { matchWords, words } from './text';
import { searchUsda, type UsdaFood } from './usda';

export interface ReconcileOptions {
  useUsda: boolean;
  webLookupForRestaurants: boolean;
}

/** Relative kcal disagreement (vs. the model's number) above which a portion is questioned. */
export const USDA_DISAGREEMENT = 0.35;
/** A garnish can differ by a large percentage without mattering to the day's total. */
export const MIN_FLAG_KCAL_DIFF = 25;
/** Assumption prefix the review UI (and approve-all) treat as a flag (defined with the approve-all rules). */
export { CHECK_PORTION_PREFIX };
/** Range used when the model's own range can't be rescaled (e.g. it estimated 0 kcal). */
const DEFAULT_RANGE_SPREAD = 0.25;
const USDA_CONCURRENCY = 3;

const log = logger('reconcile');

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure: sum item macros (rounded: kcal to 1, grams to 1). */
export function sumMacros(items: { macros: Macros }[]): Macros {
  const total = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const { macros } of items) {
    total.kcal += finite(macros.kcal);
    total.proteinG += finite(macros.proteinG);
    total.carbsG += finite(macros.carbsG);
    total.fatG += finite(macros.fatG);
  }
  return {
    kcal: Math.round(total.kcal),
    proteinG: Math.round(total.proteinG),
    carbsG: Math.round(total.carbsG),
    fatG: Math.round(total.fatG),
  };
}

/** Pure: scale per-100 g macros to `grams` (kcal to 1, macro grams to 0.1). */
export function scaleMacros(per100g: Macros, grams: number): Macros {
  const factor = Math.max(0, finite(grams)) / 100;
  return {
    kcal: Math.round(finite(per100g.kcal) * factor),
    proteinG: round1(finite(per100g.proteinG) * factor),
    carbsG: round1(finite(per100g.carbsG) * factor),
    fatG: round1(finite(per100g.fatG) * factor),
  };
}

/** Pure: macros rounded like item values (kcal to 1, grams to 0.1). */
export function roundMacros(m: Macros): Macros {
  return scaleMacros(m, 100);
}

/** Totals from the items; an estimate without items keeps its own totals (nothing to add up). */
export function itemTotals(estimate: Pick<MealEstimate, 'items' | 'totals'>): Macros {
  return estimate.items.length > 0 ? sumMacros(estimate.items) : sumMacros([{ macros: estimate.totals }]);
}

/**
 * Pure: the model's kcal range moved to a new total, keeping its relative width
 * (e.g. 400–600 around 500 becomes 480–720 around 600).
 */
export function rescaleRange(low: number, high: number, oldTotal: number, newTotal: number): { low: number; high: number } {
  const total = Math.max(0, finite(newTotal));
  if (!(oldTotal > 0) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return { low: Math.round(total * (1 - DEFAULT_RANGE_SPREAD)), high: Math.round(total * (1 + DEFAULT_RANGE_SPREAD)) };
  }
  const lowRatio = Math.min(1, Math.max(0, low / oldTotal));
  const highRatio = Math.max(1, high / oldTotal);
  return { low: Math.round(total * lowRatio), high: Math.round(total * highRatio) };
}

export function lowerConfidence(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

function atLeast(c: Confidence, floor: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[c] >= rank[floor] ? c : floor;
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function isUsableMacros(m: Macros | null | undefined): m is Macros {
  return !!m && [m.kcal, m.proteinG, m.carbsG, m.fatG].every((v) => Number.isFinite(v) && v >= 0);
}

async function quietly<T>(what: string, task: () => Promise<T | null>): Promise<T | null> {
  try {
    return await task();
  } catch (e) {
    log.warn(`${what} failed: ${errorMessage(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Barcode (Open Food Facts)
// ---------------------------------------------------------------------------

/** Which model-estimated item the scanned product is: the only item, or the best name match. */
function barcodeTarget(items: FoodItem[], product: OffProduct): number {
  const open = items.map((item, index) => ({ item, index })).filter(({ item }) => item.source === 'model');
  if (open.length === 0) return -1;
  if (items.length === 1) return open[0].index;
  const productText = `${product.name} ${product.brand ?? ''}`;
  let best = -1;
  let bestScore = 0;
  for (const { item, index } of open) {
    const forward = matchWords(words(item.name), productText);
    const backward = matchWords(words(productText), item.name);
    const score = Math.max(forward.coreMatched ? forward.recall : 0, backward.coreMatched ? backward.recall : 0);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

/** Per-100 g × the item's grams when known, else the product's serving. */
function applyBarcode(item: FoodItem, product: OffProduct): FoodItem | null {
  let macros: Macros | null = null;
  let grams = item.grams;
  if (item.grams !== null && item.grams > 0) {
    macros = scaleMacros(product.per100g, item.grams);
  } else if (isUsableMacros(product.perServing)) {
    macros = roundMacros(product.perServing);
    grams = product.servingSizeG;
  } else if (product.servingSizeG) {
    macros = scaleMacros(product.per100g, product.servingSizeG);
    grams = product.servingSizeG;
  }
  if (!isUsableMacros(macros)) return null;
  return { ...item, grams, macros, source: 'openfoodfacts', fdcId: null, modelMacros: item.modelMacros ?? item.macros };
}

// ---------------------------------------------------------------------------
// Restaurant / brand (published nutrition via web search)
// ---------------------------------------------------------------------------

function publishedItem(published: PublishedNutrition, estimate: MealEstimate, modelItems: FoodItem[]): FoodItem {
  return {
    name: published.itemName.trim() || estimate.title,
    portion: published.servingNote.trim() || '1 serving',
    grams: null,
    macros: roundMacros(published.macros),
    source: 'web',
    confidence: 'high',
    usdaQuery: null,
    fdcId: null,
    modelMacros: sumMacros(modelItems),
  };
}

function publishedNote(published: PublishedNutrition, modelKcal: number): string {
  const serving = published.servingNote.trim() ? ` (${published.servingNote.trim()})` : '';
  const source = published.source.trim() ? ` from ${published.source.trim()}` : '';
  return `Published nutrition for ${published.itemName.trim() || 'this dish'}${serving}${source}; photo estimate was ${Math.round(modelKcal)} kcal`;
}

// ---------------------------------------------------------------------------
// USDA
// ---------------------------------------------------------------------------

function usdaEligible(item: FoodItem): boolean {
  return item.source === 'model' && item.grams !== null && item.grams > 0 && !!item.usdaQuery?.trim();
}

function applyUsda(item: FoodItem, food: UsdaFood): { item: FoodItem; disagrees: boolean } {
  const macros = scaleMacros(food.per100g, item.grams ?? 0);
  const model = finite(item.macros.kcal);
  const diff = Math.abs(macros.kcal - model);
  const disagrees = diff >= MIN_FLAG_KCAL_DIFF && (model <= 0 || diff / model > USDA_DISAGREEMENT);
  return {
    item: {
      ...item,
      macros,
      source: 'usda',
      fdcId: food.fdcId,
      modelMacros: item.modelMacros ?? item.macros,
      confidence: disagrees ? lowerConfidence(item.confidence) : item.confidence,
    },
    disagrees,
  };
}

async function reconcileWithUsda(items: FoodItem[]): Promise<{ items: FoodItem[]; flagged: string[] }> {
  const out = [...items];
  const flagged = new Set<number>();
  await mapLimit(items, USDA_CONCURRENCY, async (item, index) => {
    if (!usdaEligible(item)) return;
    const food = await quietly('USDA lookup', () => searchUsda(item.usdaQuery ?? ''));
    if (!food || !isUsableMacros(food.per100g)) return;
    const result = applyUsda(item, food);
    out[index] = result.item;
    if (result.disagrees) flagged.add(index);
  });
  // Report in item order regardless of which lookup finished first.
  return { items: out, flagged: [...flagged].sort((a, b) => a - b).map((i) => items[i].name) };
}

// ---------------------------------------------------------------------------

async function reconcile(estimate: MealEstimate, opts: ReconcileOptions): Promise<MealEstimate> {
  let items = estimate.items.map((item) => ({ ...item, macros: { ...item.macros } }));
  let method = estimate.method;
  let confidence = estimate.confidence;
  const lead: string[] = [];
  const assumptions = [...estimate.assumptions];

  const barcode = estimate.barcode;
  if (barcode && isValidGtin(barcode) && method !== 'label' && method !== 'library') {
    const product = await quietly('barcode lookup', () => lookupBarcode(barcode));
    const target = product ? barcodeTarget(items, product) : -1;
    const applied = product && target >= 0 ? applyBarcode(items[target], product) : null;
    if (product && applied) {
      items[target] = applied;
      if (method === 'photo') method = 'barcode';
      lead.push(`Nutrition from Open Food Facts: ${product.brand ? `${product.brand} ` : ''}${product.name}`);
    }
  }

  let published = false;
  const brand = estimate.brand?.trim();
  if (method === 'photo' && brand && opts.webLookupForRestaurants) {
    const found = await quietly('published nutrition lookup', () => lookupPublishedNutrition(brand, estimate.title));
    if (found && isUsableMacros(found.macros) && found.macros.kcal > 0) {
      lead.push(publishedNote(found, sumMacros(items).kcal));
      items = [publishedItem(found, estimate, items)];
      method = 'restaurant';
      confidence = atLeast(confidence, 'medium');
      published = true;
    }
  }

  if (opts.useUsda && !published) {
    const usda = await reconcileWithUsda(items);
    items = usda.items;
    if (usda.flagged.length > 0) {
      confidence = lowerConfidence(confidence);
      for (const name of usda.flagged) assumptions.push(`${CHECK_PORTION_PREFIX}${name}`);
    }
  }

  const totals = itemTotals({ items, totals: estimate.totals });
  const range = rescaleRange(estimate.kcalLow, estimate.kcalHigh, estimate.totals.kcal, totals.kcal);
  return {
    ...estimate,
    items,
    totals,
    kcalLow: range.low,
    kcalHigh: range.high,
    method,
    confidence,
    assumptions: [...lead, ...assumptions],
  };
}

/** Never throws: any failure keeps the model's numbers (with totals recomputed). */
export async function reconcileEstimate(estimate: MealEstimate, opts: ReconcileOptions): Promise<MealEstimate> {
  try {
    return await reconcile(estimate, opts);
  } catch (e) {
    log.warn(`reconcile failed, keeping model numbers: ${errorMessage(e)}`);
    try {
      const totals = itemTotals(estimate);
      const range = rescaleRange(estimate.kcalLow, estimate.kcalHigh, estimate.totals.kcal, totals.kcal);
      return { ...estimate, totals, kcalLow: range.low, kcalHigh: range.high };
    } catch {
      return estimate;
    }
  }
}
