/**
 * Combine the model's itemised estimate with databases. OWNER: nutrition/pipeline builder.
 * - label / library / barcode items: keep authoritative numbers
 * - other items with grams + usdaQuery: USDA per-100g × grams; if model and USDA kcal differ
 *   by > 35 % keep the USDA number but add a `check_portion:<item>` assumption and drop
 *   confidence one level
 * - restaurant (brand set, webLookup on): published nutrition replaces the one item it is for
 *   (the whole meal only when the meal is that one item); sides, drinks, leftovers and anything
 *   the user said stay as the model estimated them
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
  /**
   * The request carried user notes or answers. They are authoritative for the model ("ate half",
   * "shared with partner"), and a published whole-item figure would override them, so the
   * published lookup is skipped.
   */
  userContext?: boolean;
  /** The run's abort signal: no lookup starts once it fires, and the web lookup is cancelled. */
  signal?: AbortSignal;
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
/**
 * Share of the words two item names must have in common (both ways) to be the same menu item.
 * Strict on purpose: "Big Mac Meal" (a combo with fries and a drink) must not replace the
 * "Big Mac" item when the fries and drink are listed too. A miss only keeps the photo estimate.
 */
const PUBLISHED_MATCH = 0.75;
/**
 * Assumptions that say the photos show a partly eaten meal: the published whole-item figure would
 * undo the leftover subtraction, so the model's numbers are kept.
 */
const PARTIAL_EATING =
  /\b(left ?overs?|left on the plate|left behind|uneaten|not eaten|half[- ]eaten|part(ly|ially)[- ]eaten|didn'?t finish|not finished|unfinished|(ate|eaten) (only )?(half|part|some)|shared|split with|subtract)/i;

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

/** Lookups are optional: a failure (including a cancelled run) keeps the model's numbers. */
async function quietly<T>(what: string, task: () => Promise<T | null>): Promise<T | null> {
  try {
    return await task();
  } catch (e) {
    log.warn(`${what} failed: ${errorMessage(e)}`);
    return null;
  }
}

function aborted(opts: ReconcileOptions): boolean {
  return opts.signal?.aborted === true;
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

/** The item the lookup is for: the meal's only item (whole dish), else the meal title. */
function publishedDish(estimate: MealEstimate, items: FoodItem[]): string {
  if (items.length === 1 && items[0].source === 'model' && items[0].name.trim()) return items[0].name;
  return estimate.title;
}

/**
 * Which model item the published numbers are for: the meal's only item, or the one model item
 * whose name and the published name mostly share their words (both ways, ignoring the brand).
 * -1 when none or several fit — e.g. a burrito bowl itemised into rice, chicken and beans matches
 * no single item, and replacing "chicken" with the whole bowl would count the rice twice.
 */
function publishedTarget(items: FoodItem[], published: PublishedNutrition, brand: string): number {
  if (items.length === 1) return items[0].source === 'model' ? 0 : -1;
  const brandWords = new Set(words(brand));
  const publishedWords = words(published.itemName).filter((w) => !brandWords.has(w));
  if (publishedWords.length === 0) return -1;
  const scored = items.flatMap((item, index) => {
    if (item.source !== 'model') return [];
    const itemWords = words(item.name).filter((w) => !brandWords.has(w));
    const covered = matchWords(publishedWords, item.name);
    const back = matchWords(itemWords, published.itemName);
    if (!covered.coreMatched || !back.coreMatched) return [];
    const score = Math.min(covered.recall, back.recall);
    return score >= PUBLISHED_MATCH ? [{ index, score }] : [];
  });
  if (scored.length === 0) return -1;
  scored.sort((a, b) => b.score - a.score);
  return scored.length > 1 && scored[1].score === scored[0].score ? -1 : scored[0].index;
}

/**
 * The published numbers for the item as served. The model's grams (its estimate of the served
 * weight) are kept so that correcting the grams in review scales the published numbers.
 */
function publishedItem(published: PublishedNutrition, item: FoodItem): FoodItem {
  return {
    name: published.itemName.trim() || item.name,
    portion: published.servingNote.trim() || item.portion || '1 serving',
    grams: item.grams,
    macros: roundMacros(published.macros),
    source: 'web',
    confidence: 'high',
    usdaQuery: null,
    fdcId: null,
    modelMacros: item.modelMacros ?? item.macros,
  };
}

function publishedNote(published: PublishedNutrition, modelKcal: number, used: boolean): string {
  const serving = published.servingNote.trim() ? ` (${published.servingNote.trim()})` : '';
  const source = published.source.trim() ? ` from ${published.source.trim()}` : '';
  const figure = used ? '' : `: ${Math.round(published.macros.kcal)} kcal (for reference; the photo estimate is kept)`;
  const estimateNote = used ? `; photo estimate was ${Math.round(modelKcal)} kcal` : '';
  return `Published nutrition for ${published.itemName.trim() || 'this dish'}${serving}${source}${figure}${estimateNote}`;
}

function mentionsPartialEating(assumptions: string[]): boolean {
  return assumptions.some((a) => PARTIAL_EATING.test(a));
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

async function reconcileWithUsda(items: FoodItem[], signal?: AbortSignal): Promise<{ items: FoodItem[]; flagged: string[] }> {
  const out = [...items];
  const flagged = new Set<number>();
  await mapLimit(items, USDA_CONCURRENCY, async (item, index) => {
    if (!usdaEligible(item) || signal?.aborted) return;
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
  if (barcode && isValidGtin(barcode) && method !== 'label' && method !== 'library' && !aborted(opts)) {
    const product = await quietly('barcode lookup', () => lookupBarcode(barcode));
    const target = product ? barcodeTarget(items, product) : -1;
    const applied = product && target >= 0 ? applyBarcode(items[target], product) : null;
    if (product && applied) {
      items[target] = applied;
      if (method === 'photo') method = 'barcode';
      lead.push(`Nutrition from Open Food Facts: ${product.brand ? `${product.brand} ` : ''}${product.name}`);
    }
  }

  const brand = estimate.brand?.trim();
  // Notes / answers and leftovers make the model's numbers describe what was actually eaten;
  // a published whole-item figure would override that, so it isn't looked up at all.
  const partial = opts.userContext === true || mentionsPartialEating(estimate.assumptions);
  if (method === 'photo' && brand && opts.webLookupForRestaurants && !partial && !aborted(opts)) {
    const found = await quietly('published nutrition lookup', () =>
      lookupPublishedNutrition(brand, publishedDish(estimate, items), { signal: opts.signal }),
    );
    if (found && isUsableMacros(found.macros) && found.macros.kcal > 0) {
      const target = publishedTarget(items, found, brand);
      if (target >= 0) {
        lead.push(publishedNote(found, items[target].macros.kcal, true));
        items[target] = publishedItem(found, items[target]);
        method = 'restaurant';
        // The published figure is the whole meal only when the meal is that one item.
        if (items.length === 1) confidence = atLeast(confidence, 'medium');
      } else {
        lead.push(publishedNote(found, sumMacros(items).kcal, false));
      }
    }
  }

  if (opts.useUsda && !aborted(opts)) {
    const usda = await reconcileWithUsda(items, opts.signal);
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
