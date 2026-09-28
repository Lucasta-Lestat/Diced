/**
 * USDA FoodData Central lookups (https://api.nal.usda.gov/fdc/v1). OWNER: nutrition/pipeline builder.
 * Uses the user's key from SecureStore (`usdaApiKey`) or `DEMO_KEY`. Results cached in kv.
 */
import { getSecret } from '../config/settings';
import { kvGet, kvSet } from '../db/database';
import { errorMessage, logger } from '../lib/log';
import type { Macros } from '../types';
import { getJson, HttpStatusError, isRecord, toAmount } from './http';
import { matchWords, normalizeText, words } from './text';

export interface UsdaFood {
  fdcId: number;
  description: string;
  dataType: string;
  /** Nutrients per 100 g. */
  per100g: Macros;
}

const SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const DATA_TYPES = 'Foundation,SR%20Legacy,Survey%20(FNDDS)';
const PAGE_SIZE = 10;
export const USDA_CACHE_PREFIX = 'usda:';
/** Below this weighted share of query words the match is too weak; the model's number is kept. */
export const MIN_USDA_RECALL = 0.6;
/** DEMO_KEY allows only a few requests per hour per IP; don't hammer it after a 429. */
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/** Nothing edible exceeds pure fat (~900 kcal/100 g); larger values are unit mix-ups. */
const MAX_KCAL_PER_100G = 950;

const PREFERRED_TYPES = new Set(['Foundation', 'SR Legacy', 'Survey (FNDDS)']);
const OTHER_TYPE_WEIGHT = 0.85;

/**
 * Nutrient ids (and legacy numbers) as they appear in search results. Foundation foods often
 * lack 1008 and carry Atwater energies instead; the specific factors (2048) match SR Legacy
 * best, so they win over the general ones (2047).
 */
const ENERGY = [
  { id: 1008, number: '208' },
  { id: 2048, number: '958' },
  { id: 2047, number: '957' },
];
const PROTEIN = [{ id: 1003, number: '203' }];
const FAT = [
  { id: 1004, number: '204' },
  { id: 1085, number: '298' },
];
const CARBS = [
  { id: 1005, number: '205' },
  { id: 1050, number: '205.2' },
];

const log = logger('usda');

interface CacheEntry {
  food: UsdaFood | null;
  at: number;
}

let rateLimitedUntil = 0;

/** Cache key part: normalized words in their original order. */
export function normalizeUsdaQuery(query: string): string {
  return normalizeText(query);
}

interface NutrientValue {
  value: number;
  unit: string | null;
}

function indexNutrients(nutrients: unknown): { byId: Map<number, NutrientValue>; byNumber: Map<string, NutrientValue> } {
  const byId = new Map<number, NutrientValue>();
  const byNumber = new Map<string, NutrientValue>();
  if (!Array.isArray(nutrients)) return { byId, byNumber };
  for (const n of nutrients) {
    if (!isRecord(n)) continue;
    // Live search results use nutrientId/nutrientNumber/value; the published 2020 spec says number/amount.
    const value = toAmount(n.value ?? n.amount);
    if (value === null) continue;
    const unit = typeof n.unitName === 'string' ? n.unitName.toLowerCase() : null;
    const entry = { value, unit };
    const id = typeof n.nutrientId === 'number' ? n.nutrientId : null;
    const number = n.nutrientNumber ?? n.number;
    if (id !== null && !byId.has(id)) byId.set(id, entry);
    if ((typeof number === 'string' || typeof number === 'number') && !byNumber.has(String(number))) {
      byNumber.set(String(number), entry);
    }
  }
  return { byId, byNumber };
}

function pick(
  index: ReturnType<typeof indexNutrients>,
  keys: { id: number; number: string }[],
  unit: string,
): number | null {
  for (const key of keys) {
    const hit = index.byId.get(key.id) ?? index.byNumber.get(key.number);
    if (hit && (hit.unit === null || hit.unit === unit)) return hit.value;
  }
  return null;
}

/** Pure: per-100 g macros from a search result's `foodNutrients`, or null without usable energy. */
export function usdaPer100g(nutrients: unknown): Macros | null {
  const index = indexNutrients(nutrients);
  const kcal = pick(index, ENERGY, 'kcal');
  if (kcal === null || kcal > MAX_KCAL_PER_100G) return null;
  return {
    kcal,
    proteinG: pick(index, PROTEIN, 'g') ?? 0,
    carbsG: pick(index, CARBS, 'g') ?? 0,
    fatG: pick(index, FAT, 'g') ?? 0,
  };
}

/**
 * Pure: the best-matching food in a `/foods/search` response for `query`, or null when no
 * candidate is a strong enough word match (the model's own number is better than a wrong food).
 * Score = mostly the share of query words found, a little for description specificity, weighted
 * toward Foundation / SR Legacy / FNDDS; the API's relevance order breaks ties.
 */
export function pickBestUsdaFood(query: string, body: unknown): UsdaFood | null {
  const queryWords = words(query);
  if (queryWords.length === 0 || !isRecord(body) || !Array.isArray(body.foods)) return null;
  const foods: unknown[] = body.foods;
  let best: { food: UsdaFood; score: number } | null = null;
  for (let index = 0; index < foods.length; index++) {
    const raw = foods[index];
    if (!isRecord(raw) || typeof raw.fdcId !== 'number' || typeof raw.description !== 'string') continue;
    const match = matchWords(queryWords, raw.description);
    if (!match.coreMatched || match.recall < MIN_USDA_RECALL) continue;
    const per100g = usdaPer100g(raw.foodNutrients);
    if (!per100g) continue;
    const dataType = typeof raw.dataType === 'string' ? raw.dataType : '';
    const typeWeight = PREFERRED_TYPES.has(dataType) ? 1 : OTHER_TYPE_WEIGHT;
    const score = (0.8 * match.recall + 0.2 * match.precision) * typeWeight - index * 1e-4;
    if (!best || score > best.score) {
      best = { food: { fdcId: raw.fdcId, description: raw.description, dataType, per100g }, score };
    }
  }
  return best?.food ?? null;
}

async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const entry = await kvGet<CacheEntry>(key);
    return entry && typeof entry === 'object' && 'food' in entry ? entry : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, food: UsdaFood | null): Promise<void> {
  try {
    await kvSet<CacheEntry>(key, { food, at: Date.now() });
  } catch (e) {
    log.warn(`could not cache USDA result: ${errorMessage(e)}`);
  }
}

async function apiKey(): Promise<string> {
  try {
    return (await getSecret('usdaApiKey')) ?? 'DEMO_KEY';
  } catch {
    return 'DEMO_KEY';
  }
}

/**
 * Best match for a phrase, preferring Foundation / SR Legacy / Survey (FNDDS) over Branded.
 * Found foods and weak matches (null) are cached; network errors and rate limits are not, so
 * they are retried later.
 */
export async function searchUsda(query: string): Promise<UsdaFood | null> {
  const normalized = normalizeUsdaQuery(query);
  if (!normalized) return null;
  const cacheKey = `${USDA_CACHE_PREFIX}${normalized}`;
  const cached = await readCache(cacheKey);
  if (cached) return cached.food;
  if (Date.now() < rateLimitedUntil) return null;

  let body: unknown;
  try {
    const key = await apiKey();
    body = await getJson(
      `${SEARCH_URL}?query=${encodeURIComponent(normalized)}&dataType=${DATA_TYPES}` +
        `&pageSize=${PAGE_SIZE}&api_key=${encodeURIComponent(key)}`,
    );
  } catch (e) {
    if (e instanceof HttpStatusError && e.status === 429) rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    log.warn(`USDA search failed: ${errorMessage(e)}`);
    return null;
  }
  const food = pickBestUsdaFood(normalized, body);
  await writeCache(cacheKey, food);
  return food;
}

/** Test-only: forget the rate-limit back-off. */
export function __resetUsdaForTests(): void {
  rateLimitedUntil = 0;
}
