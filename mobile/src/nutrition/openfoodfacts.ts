/** Open Food Facts barcode lookup. OWNER: nutrition/pipeline builder. */
import type { Macros } from '../types';

export interface OffProduct {
  code: string;
  name: string;
  brand: string | null;
  servingSizeG: number | null;
  per100g: Macros;
  perServing: Macros | null;
}

/** GTIN-8/12/13/14 check-digit validation. Pure. */
export function isValidGtin(code: string): boolean {
  throw new Error('not implemented');
}

/** Product by barcode, or null (invalid code, not found, network error). */
export async function lookupBarcode(code: string): Promise<OffProduct | null> {
  throw new Error('not implemented');
}
