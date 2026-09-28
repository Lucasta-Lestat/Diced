/** Open Food Facts barcode lookup. OWNER: nutrition/pipeline builder. */
import { errorMessage, logger } from '../lib/log';
import type { Macros } from '../types';
import { getJson, isRecord, toAmount } from './http';

export interface OffProduct {
  code: string;
  name: string;
  brand: string | null;
  servingSizeG: number | null;
  per100g: Macros;
  perServing: Macros | null;
}

const PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'code,product_name,brands,serving_quantity,nutriments';
/** OFF asks API clients to identify themselves. */
const USER_AGENT = 'Diced/0.1 (personal prototype)';
const GTIN_LENGTHS = [8, 12, 13, 14];
/** OFF's plain `energy_*` fields are always kJ. */
const KJ_PER_KCAL = 4.184;

const log = logger('openfoodfacts');

/** Digits only: the model may report `5 449000 000996` or `5449-000-000996`. */
export function normalizeGtin(code: string): string {
  return code.replace(/[\s-]/g, '');
}

/** GTIN-8/12/13/14 check-digit validation. Pure. */
export function isValidGtin(code: string): boolean {
  const gtin = normalizeGtin(code);
  if (!/^\d+$/.test(gtin) || !GTIN_LENGTHS.includes(gtin.length) || /^0+$/.test(gtin)) return false;
  const digits = [...gtin].map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  // Weights alternate 3, 1, 3, … starting from the digit next to the check digit.
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = 4 - weight) sum += digits[i] * weight;
  return (10 - (sum % 10)) % 10 === check;
}

function energyKcal(n: Record<string, unknown>, suffix: '_100g' | '_serving'): number | null {
  const kcal = toAmount(n[`energy-kcal${suffix}`]);
  if (kcal !== null) return kcal;
  const kj = toAmount(n[`energy${suffix}`]);
  return kj === null ? null : kj / KJ_PER_KCAL;
}

function macrosFrom(n: Record<string, unknown>, suffix: '_100g' | '_serving', fallback?: Macros): Macros | null {
  const kcal = energyKcal(n, suffix);
  if (kcal === null) return null;
  return {
    kcal,
    proteinG: toAmount(n[`proteins${suffix}`]) ?? fallback?.proteinG ?? 0,
    carbsG: toAmount(n[`carbohydrates${suffix}`]) ?? fallback?.carbsG ?? 0,
    fatG: toAmount(n[`fat${suffix}`]) ?? fallback?.fatG ?? 0,
  };
}

function scaled(m: Macros, factor: number): Macros {
  return { kcal: m.kcal * factor, proteinG: m.proteinG * factor, carbsG: m.carbsG * factor, fatG: m.fatG * factor };
}

function firstBrand(brands: unknown): string | null {
  if (typeof brands !== 'string') return null;
  return brands.split(',').map((b) => b.trim()).find(Boolean) ?? null;
}

/**
 * Pure: the product in an `/api/v2/product/<code>.json` response, or null when not found or
 * without usable nutrition (energy per 100 g, or per serving plus the serving size).
 */
export function parseOffProduct(body: unknown, requestedCode: string): OffProduct | null {
  if (!isRecord(body) || body.status !== 1 || !isRecord(body.product)) return null;
  const product = body.product;
  const nutriments = isRecord(product.nutriments) ? product.nutriments : {};
  const servingSizeG = toAmount(product.serving_quantity) || null;

  let per100g = macrosFrom(nutriments, '_100g');
  const derivedServing = per100g && servingSizeG ? scaled(per100g, servingSizeG / 100) : undefined;
  const perServing = macrosFrom(nutriments, '_serving', derivedServing);
  if (!per100g && perServing && servingSizeG) per100g = scaled(perServing, 100 / servingSizeG);
  if (!per100g) return null;

  const code = typeof product.code === 'string' && product.code ? product.code : requestedCode;
  const name = typeof product.product_name === 'string' ? product.product_name.trim() : '';
  return {
    code,
    name: name || `Barcode ${code}`,
    brand: firstBrand(product.brands),
    servingSizeG,
    per100g,
    perServing,
  };
}

/** Product by barcode, or null (invalid code, not found, network error). */
export async function lookupBarcode(code: string): Promise<OffProduct | null> {
  const gtin = normalizeGtin(code);
  if (!isValidGtin(gtin)) return null;
  try {
    const body = await getJson(`${PRODUCT_URL}${gtin}.json?fields=${FIELDS}`, {
      headers: { 'User-Agent': USER_AGENT },
      // Unknown products come back as 404 with `status: 0` in the body.
      okStatuses: [404],
    });
    return parseOffProduct(body, gtin);
  } catch (e) {
    log.warn(`barcode lookup failed: ${errorMessage(e)}`);
    return null;
  }
}
