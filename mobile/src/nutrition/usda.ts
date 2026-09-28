/**
 * USDA FoodData Central lookups (https://api.nal.usda.gov/fdc/v1). OWNER: nutrition/pipeline builder.
 * Uses the user's key from SecureStore (`usdaApiKey`) or `DEMO_KEY`. Results cached in kv.
 */
import type { Macros } from '../types';

export interface UsdaFood {
  fdcId: number;
  description: string;
  dataType: string;
  /** Nutrients per 100 g. */
  per100g: Macros;
}

/** Best match for a phrase, preferring Foundation / SR Legacy / Survey (FNDDS) over Branded. */
export async function searchUsda(query: string): Promise<UsdaFood | null> {
  throw new Error('not implemented');
}
