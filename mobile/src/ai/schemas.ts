/**
 * Structured-output schemas (zod v4) and pure converters to the app's types. OWNER: AI builder.
 *
 * Structured outputs don't support numeric ranges, string lengths or array bounds, and the SDK's
 * zod helper sends `enum` only as description text. So choice fields are plain strings whose
 * allowed values are spelled out in the description, and every range / enum / count rule is
 * enforced here in code. Pure — no native imports.
 */
import { z } from 'zod';
import type {
  ClarifyingQuestion,
  Confidence,
  FoodItem,
  ItemSource,
  Macros,
  MealEstimate,
  PhotoCategory,
  WeightUnit,
} from '../types';
import type { ClassifyOutput } from './classify';
import type { PublishedNutrition } from './restaurant';
import type { ScaleReading } from './scale';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const PHOTO_CATEGORIES = ['scale', 'food', 'nutrition_label', 'other'] as const;

function choice(values: readonly string[], description: string) {
  return z.string().describe(`${description} One of: ${values.map((v) => `"${v}"`).join(', ')}.`);
}

/** Normalises a model-supplied choice (`"Nutrition label"` → `nutrition_label`), else `fallback`. */
export function pickChoice<T extends string>(raw: unknown, values: readonly T[], fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Finite, non-negative number or 0. */
function nonNeg(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function round(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function cleanText(s: unknown): string {
  return typeof s === 'string' ? s.trim() : '';
}

function nullableText(s: unknown): string | null {
  const t = cleanText(s);
  return t && !/^(none|null|n\/a|unknown)$/i.test(t) ? t : null;
}

function cleanList(list: unknown, max = Infinity): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    const t = cleanText(entry);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function lowerConfidence(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

export function confidenceRank(c: Confidence): number {
  return CONFIDENCE_RANK[c];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export const ClassifySchema = z.object({
  photos: z
    .array(
      z.object({
        photo: z.number().describe('The photo number as labelled ("Photo 3" → 3).'),
        category: choice(PHOTO_CATEGORIES, 'What the photo shows.'),
        confidence: z.number().describe('Probability from 0 to 1 that the category is right.'),
      }),
    )
    .describe('Exactly one entry per photo, in photo order.'),
});
export type ClassifyRaw = z.infer<typeof ClassifySchema>;

/**
 * Maps 1-based photo numbers back to asset ids. Out-of-range or repeated numbers are ignored;
 * photos the model skipped become `other` with confidence 0.
 */
export function toClassifyResults(raw: ClassifyRaw, assetIds: string[]): Record<string, ClassifyOutput> {
  const out: Record<string, ClassifyOutput> = {};
  for (const entry of raw.photos) {
    const index = Math.round(entry.photo) - 1;
    const assetId = assetIds[index];
    if (assetId === undefined || assetId in out) continue;
    const confidence = Number.isFinite(entry.confidence) ? clamp(entry.confidence, 0, 1) : 0;
    out[assetId] = { category: pickChoice<PhotoCategory>(entry.category, PHOTO_CATEGORIES, 'other'), confidence };
  }
  for (const assetId of assetIds) {
    if (!(assetId in out)) out[assetId] = { category: 'other', confidence: 0 };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

const READING_KINDS = ['body_weight', 'other_metric', 'no_reading'] as const;
const DISPLAY_UNITS = ['lb', 'kg', 'st', 'unknown'] as const;

export const ScaleSchema = z.object({
  is_scale: z.boolean().describe('True if the photo shows a body-weight (bathroom) scale display.'),
  display_text: z
    .string()
    .describe('Exactly what the display shows, character for character, e.g. "172.4 lb", "78.20", "12 st 4.6", "--.-". Empty if nothing is lit.'),
  reading_kind: choice(
    READING_KINDS,
    'What the display shows: a body-weight number, another metric (body fat %, BMI, water, muscle, bone, a greeting), or no usable number (blank, dashes, error, still changing).',
  ),
  value: z
    .number()
    .nullable()
    .describe('The body weight as displayed, in the displayed unit (for stones: the whole stones only). Null unless reading_kind is "body_weight" and every digit is legible.'),
  unit: choice(DISPLAY_UNITS, 'The unit indicator visible on the display; "unknown" if none is visible.'),
  stone_pounds: z.number().nullable().describe('Only for stone displays: the pounds part ("12 st 4.6" → 4.6). Otherwise null.'),
  confidence: choice(CONFIDENCE_LEVELS, 'How sure you are of the value.'),
  issues: z.array(z.string()).describe('Short phrases for anything that makes the reading uncertain. Empty if none.'),
});
export type ScaleRaw = z.infer<typeof ScaleSchema>;

/** The sheet only accepts 50–700 lb; anything outside is almost certainly a misread. */
export const PLAUSIBLE_LB = { min: 50, max: 700 } as const;
const LB_PER_KG = 2.20462;

function toScaleUnit(raw: ScaleRaw, expectedUnit: WeightUnit): { value: number; unit: WeightUnit; note: string | null } | null {
  const value = raw.value;
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const unit = pickChoice(raw.unit, DISPLAY_UNITS, 'unknown');
  if (unit === 'st') {
    const pounds = raw.stone_pounds !== null && Number.isFinite(raw.stone_pounds) ? clamp(raw.stone_pounds, 0, 13.99) : 0;
    return { value: round(value * 14 + pounds, 2), unit: 'lb', note: 'converted from stones' };
  }
  if (unit === 'unknown') return { value: round(value, 2), unit: expectedUnit, note: null };
  const note = unit !== expectedUnit ? `display shows ${unit} (settings say ${expectedUnit})` : null;
  return { value: round(value, 2), unit, note };
}

export function toScaleReading(raw: ScaleRaw, expectedUnit: WeightUnit): ScaleReading {
  const issues = cleanList(raw.issues, 8);
  let confidence = pickChoice<Confidence>(raw.confidence, CONFIDENCE_LEVELS, 'low');
  if (!raw.is_scale) return { isScale: false, value: null, unit: null, confidence: 'low', issues };

  const kind = pickChoice(raw.reading_kind, READING_KINDS, 'no_reading');
  const reading = kind === 'body_weight' ? toScaleUnit(raw, expectedUnit) : null;
  if (!reading) {
    const why = kind === 'other_metric' ? 'display shows another metric, not body weight' : 'no legible weight on the display';
    return { isScale: true, value: null, unit: null, confidence: 'low', issues: issues.length ? issues : [why] };
  }
  if (reading.note) issues.push(reading.note);
  const lb = reading.unit === 'kg' ? reading.value * LB_PER_KG : reading.value;
  if (lb < PLAUSIBLE_LB.min || lb > PLAUSIBLE_LB.max) {
    confidence = 'low';
    issues.push('value outside the plausible body-weight range');
  }
  return { isScale: true, value: reading.value, unit: reading.unit, confidence, issues };
}

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

const ITEM_BASES = ['estimate', 'label', 'library'] as const;
const MODEL_METHODS = ['photo', 'label', 'library'] as const;

const FoodItemSchema = z.object({
  name: z.string().describe('Short specific name, e.g. "grilled chicken thigh", "white rice", "olive oil (cooking)".'),
  portion: z.string().describe('Human portion, e.g. "1 cup", "2 slices", "1.5 servings (45 g)".'),
  grams: z
    .number()
    .nullable()
    .describe('Estimated edible grams actually eaten (cooked weight). Null only when a weight is meaningless for the item.'),
  kcal: z.number().describe('Calories for the portion eaten.'),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  basis: choice(ITEM_BASES, 'Where the numbers come from: your visual estimate, a legible nutrition label, or a matched usual meal.'),
  confidence: choice(CONFIDENCE_LEVELS, 'Confidence in this item\'s numbers.'),
  usda_query: z
    .string()
    .nullable()
    .describe('USDA FoodData Central-style description for a per-100 g lookup, e.g. "chicken breast, roasted, meat only". Null for label and library items.'),
});

const QuestionSchema = z.object({
  question: z.string().describe('Short question, e.g. "How much oil was the chicken cooked in?"'),
  options: z.array(z.string()).describe('2-4 short answers covering the realistic range, e.g. ["None", "1 tsp", "1 tbsp", "2+ tbsp"].'),
  affects: z.array(z.string()).describe('Names of the items the answer changes, exactly as in items.'),
  kcal_swing: z.number().describe('How many kcal the meal total would change between the lowest- and highest-calorie answer.'),
});

export const FoodSchema = z.object({
  contains_food: z.boolean().describe('False if the photos show no food or drink at all.'),
  leftovers_only: z
    .boolean()
    .describe('True if no photo shows the food before it was eaten: only a partly eaten or empty plate, leftovers or an opened package.'),
  title: z.string().describe('2-6 word meal title, e.g. "Chicken burrito bowl".'),
  method: choice(MODEL_METHODS, 'Main basis of the estimate: the photos, a nutrition label, or a matched usual meal.'),
  items: z.array(FoodItemSchema).describe('Every component eaten, one entry each.'),
  kcal_low: z.number().describe('Low end of a realistic range for the meal total.'),
  kcal_high: z.number().describe('High end of a realistic range for the meal total.'),
  confidence: choice(CONFIDENCE_LEVELS, 'Overall confidence in the total.'),
  questions: z.array(QuestionSchema).describe('At most 3, only if an answer would move the total by more than 10%.'),
  assumptions: z.array(z.string()).describe('Assumptions the estimate relies on (hidden oil, portion basis, leftovers, label servings).'),
  library_item_id: z.string().nullable().describe('id of the matched usual meal, or null.'),
  brand: z.string().nullable().describe('Chain restaurant or packaged brand, if recognised; else null.'),
  barcode: z.string().nullable().describe('Barcode digits if every digit is legible; else null.'),
});
export type FoodRaw = z.infer<typeof FoodSchema>;

export const MAX_QUESTIONS = 3;
export const MAX_OPTIONS = 4;
/** A question is only worth the user's time when its answer moves the total by more than this. */
export const QUESTION_MIN_SHARE = 0.1;
const BARCODE_LENGTHS = new Set([8, 12, 13, 14]);

const ITEM_SOURCE: Record<(typeof ITEM_BASES)[number], ItemSource> = {
  estimate: 'model',
  label: 'label',
  library: 'library',
};

export function roundMacros(m: Macros): Macros {
  return { kcal: Math.round(m.kcal), proteinG: round(m.proteinG, 1), carbsG: round(m.carbsG, 1), fatG: round(m.fatG, 1) };
}

/** Sum of item macros (kcal to the unit, grams to 0.1). */
export function sumItemMacros(items: { macros: Macros }[]): Macros {
  const total = items.reduce(
    (acc, { macros }) => ({
      kcal: acc.kcal + macros.kcal,
      proteinG: acc.proteinG + macros.proteinG,
      carbsG: acc.carbsG + macros.carbsG,
      fatG: acc.fatG + macros.fatG,
    }),
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
  return roundMacros(total);
}

/** low ≤ total ≤ high, both ≥ 0, falling back to the total when the model's numbers are unusable. */
export function saneRange(low: number, high: number, total: number): { kcalLow: number; kcalHigh: number } {
  let lo = Number.isFinite(low) ? low : total;
  let hi = Number.isFinite(high) ? high : total;
  if (lo > hi) [lo, hi] = [hi, lo];
  return { kcalLow: Math.round(Math.max(0, Math.min(lo, total))), kcalHigh: Math.round(Math.max(hi, total)) };
}

function toFoodItem(raw: FoodRaw['items'][number]): FoodItem {
  const basis = pickChoice(raw.basis, ITEM_BASES, 'estimate');
  const macros = roundMacros({
    kcal: nonNeg(raw.kcal),
    proteinG: nonNeg(raw.protein_g),
    carbsG: nonNeg(raw.carbs_g),
    fatG: nonNeg(raw.fat_g),
  });
  const grams = raw.grams !== null && Number.isFinite(raw.grams) && raw.grams > 0 ? Math.round(raw.grams) : null;
  return {
    name: cleanText(raw.name) || 'Unnamed item',
    portion: cleanText(raw.portion),
    grams,
    macros,
    source: ITEM_SOURCE[basis],
    confidence: pickChoice<Confidence>(raw.confidence, CONFIDENCE_LEVELS, 'low'),
    usdaQuery: basis === 'estimate' ? nullableText(raw.usda_query) : null,
    fdcId: null,
    modelMacros: { ...macros },
  };
}

function toQuestions(raw: FoodRaw['questions'], totalKcal: number): ClarifyingQuestion[] {
  const minSwing = totalKcal * QUESTION_MIN_SHARE;
  return raw
    .map((q) => ({
      question: cleanText(q.question),
      options: cleanList(q.options, MAX_OPTIONS),
      affects: cleanList(q.affects),
      swing: Number.isFinite(q.kcal_swing) ? Math.abs(q.kcal_swing) : 0,
    }))
    .filter((q) => q.question && q.options.length >= 2 && q.swing > minSwing)
    .slice(0, MAX_QUESTIONS)
    .map((q, i) => ({ id: `q${i + 1}`, question: q.question, options: q.options, affects: q.affects }));
}

/** Digits only, and only for plausible GTIN lengths; the check digit is validated by the caller. */
export function cleanBarcode(raw: string | null): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return BARCODE_LENGTHS.has(digits.length) ? digits : null;
}

export interface MealContext {
  /** Model that produced the answer. */
  model: string;
  /** Ids of the library items offered to the model; anything else is treated as no match. */
  libraryIds: readonly string[];
  now: number;
}

export function toMealEstimate(raw: FoodRaw, ctx: MealContext): MealEstimate {
  const assumptions = cleanList(raw.assumptions);
  // Only present when true, so estimates that aren't "after" photos look exactly as before.
  const leftovers = raw.leftovers_only === true ? { leftoversOnly: true } : {};
  if (!raw.contains_food) {
    return {
      title: cleanText(raw.title) || 'No food found',
      items: [],
      totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
      kcalLow: 0,
      kcalHigh: 0,
      confidence: 'low',
      method: 'photo',
      questions: [],
      assumptions: assumptions.length ? assumptions : ['No food or drink was found in these photos.'],
      libraryItemId: null,
      brand: null,
      barcode: null,
      model: ctx.model,
      samples: 1,
      createdAt: ctx.now,
      ...leftovers,
    };
  }
  const items = raw.items.map(toFoodItem);
  const totals = sumItemMacros(items);
  const libraryItemId = raw.library_item_id && ctx.libraryIds.includes(raw.library_item_id) ? raw.library_item_id : null;
  let method = pickChoice(raw.method, MODEL_METHODS, 'photo');
  if (method === 'library' && !libraryItemId) method = 'photo';
  return {
    title: cleanText(raw.title) || items[0]?.name || 'Meal',
    items,
    totals,
    ...saneRange(raw.kcal_low, raw.kcal_high, totals.kcal),
    confidence: pickChoice<Confidence>(raw.confidence, CONFIDENCE_LEVELS, 'low'),
    method,
    questions: toQuestions(raw.questions, totals.kcal),
    assumptions,
    libraryItemId,
    brand: nullableText(raw.brand),
    barcode: cleanBarcode(raw.barcode),
    model: ctx.model,
    samples: 1,
    createdAt: ctx.now,
    ...leftovers,
  };
}

// ---------------------------------------------------------------------------
// Restaurant lookup (strict client tool input)
// ---------------------------------------------------------------------------

export const ReportNutritionSchema = z.object({
  found: z.boolean(),
  source_url: z.string().nullable(),
  item_name: z.string().nullable(),
  kcal: z.number().nullable(),
  protein_g: z.number().nullable(),
  carbs_g: z.number().nullable(),
  fat_g: z.number().nullable(),
  serving_note: z.string().nullable(),
});
export type ReportNutritionRaw = z.infer<typeof ReportNutritionSchema>;

/** Null unless the model found published numbers with a web source. */
export function toPublishedNutrition(input: unknown, dish: string): PublishedNutrition | null {
  const parsed = ReportNutritionSchema.safeParse(input);
  if (!parsed.success) return null;
  const r = parsed.data;
  const source = cleanText(r.source_url);
  if (!r.found || r.kcal === null || !(r.kcal > 0) || !/^https?:\/\/\S+$/i.test(source)) return null;
  return {
    source,
    itemName: cleanText(r.item_name) || dish.trim(),
    macros: roundMacros({ kcal: r.kcal, proteinG: nonNeg(r.protein_g), carbsG: nonNeg(r.carbs_g), fatG: nonNeg(r.fat_g) }),
    servingNote: cleanText(r.serving_note),
  };
}
