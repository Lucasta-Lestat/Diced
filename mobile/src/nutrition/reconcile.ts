/**
 * Combine the model's itemised estimate with databases. OWNER: nutrition/pipeline builder.
 * - label / library / barcode items: keep authoritative numbers
 * - other items with grams + usdaQuery: USDA per-100g × grams; if model and USDA kcal differ
 *   by > 35 % keep the USDA number but add a `check_portion:<item>` assumption and drop
 *   confidence one level
 * - restaurant (brand set, webLookup on): published nutrition replaces the total
 * Always recomputes totals and the kcal range.
 */
import type { MealEstimate } from '../types';

export interface ReconcileOptions {
  useUsda: boolean;
  webLookupForRestaurants: boolean;
}

export async function reconcileEstimate(estimate: MealEstimate, opts: ReconcileOptions): Promise<MealEstimate> {
  throw new Error('not implemented');
}

/** Pure: sum item macros (rounded: kcal to 1, grams to 1). */
export function sumMacros(items: { macros: import('../types').Macros }[]): import('../types').Macros {
  throw new Error('not implemented');
}

/** Pure: scale per-100 g macros to `grams`. */
export function scaleMacros(per100g: import('../types').Macros, grams: number): import('../types').Macros {
  throw new Error('not implemented');
}
