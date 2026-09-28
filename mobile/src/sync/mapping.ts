/** Pure mapping between app entries and sheet rows. OWNER: data-layer builder. */
import type { FoodItem, LibraryItem, MealEntry, MealSlot, WeightEntry } from '../types';
import type { SheetConfidence, SheetLibraryItem, SheetMealRow, SheetWeightRow } from './contract';

/** Sheet Notes cells are for humans; keep them short. */
export const MAX_NOTES_CHARS = 500;
/** Only the first few assumptions are "key" enough for the sheet. */
const MAX_ASSUMPTIONS = 3;
const SEP = ' · ';

const FLAG_LABELS: Record<string, string> = {
  differs_from_trend: 'differs from recent trend',
  unit_converted: 'converted from kg',
  multiple_readings: 'several readings that day',
  low_read_confidence: 'display hard to read',
  not_morning: 'not a morning weigh-in',
};

/** Human-readable label for a machine flag (`some_flag` → `some flag` when unknown). */
export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ');
}

/** Cuts `text` to `max` chars, ending with an ellipsis when shortened. */
export function truncate(text: string, max: number = MAX_NOTES_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round0 = (n: number) => Math.round(Number.isFinite(n) ? n : 0);

/** Throws if the entry has no value. */
export function weightEntryToRow(entry: WeightEntry): SheetWeightRow {
  if (entry.valueLb === null || !Number.isFinite(entry.valueLb)) {
    throw new Error(`Weight entry ${entry.id} has no value`);
  }
  const flags = [...new Set(entry.flags)].map(flagLabel);
  const notes = [entry.notes.trim(), flags.length ? `Flags: ${flags.join(', ')}` : '']
    .filter(Boolean)
    .join(SEP);
  return {
    entryId: entry.id,
    date: entry.localDate,
    time: entry.time ?? '',
    person: entry.person,
    weightLb: round1(entry.valueLb),
    source: entry.source,
    confidence: entry.confidence,
    notes: truncate(notes),
  };
}

/** `chicken breast 150 g (248 kcal)`, or the portion when grams are unknown. */
export function formatItem(item: FoodItem): string {
  const amount =
    item.grams !== null && Number.isFinite(item.grams) ? `${round0(item.grams)} g` : item.portion.trim();
  const kcal = `(${round0(item.macros.kcal)} kcal)`;
  return [item.name.trim(), amount, kcal].filter(Boolean).join(' ');
}

/** `Q: A` lines for answered clarifying questions (answers to unknown questions are skipped). */
function answeredQuestions(meal: MealEntry): string[] {
  const questions = meal.estimate?.questions ?? [];
  return questions.flatMap((q) => {
    const answer = meal.answers[q.id]?.trim();
    if (!answer) return [];
    const question = q.question.trim().replace(/[\s?:]+$/, '');
    return [`${question}: ${answer}`];
  });
}

function mealNotes(meal: MealEntry): string {
  const assumptions = (meal.estimate?.assumptions ?? [])
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, MAX_ASSUMPTIONS);
  const parts = [
    meal.notes.trim(),
    ...answeredQuestions(meal),
    assumptions.length ? `Assumed: ${assumptions.join('; ')}` : '',
  ].filter(Boolean);
  return truncate(parts.join(SEP));
}

/** `items` column text: `name grams g (kcal kcal) · …`; notes = user notes + assumptions + answers. */
export function mealEntryToRow(meal: MealEntry): SheetMealRow {
  const estimate = meal.estimate;
  // A meal typed in by hand has no estimate; "medium" = a person's own guess.
  const confidence: SheetConfidence = estimate?.confidence ?? 'medium';
  return {
    entryId: meal.id,
    date: meal.localDate,
    time: meal.time,
    person: meal.person,
    meal: slotToSheetMeal(meal.slot),
    description: meal.title.trim() || estimate?.title.trim() || slotToSheetMeal(meal.slot),
    kcal: round0(meal.final.kcal),
    proteinG: round0(meal.final.proteinG),
    carbsG: round0(meal.final.carbsG),
    fatG: round0(meal.final.fatG),
    confidence,
    method: estimate?.method ?? 'manual',
    items: (estimate?.items ?? []).map(formatItem).join(SEP),
    notes: mealNotes(meal),
  };
}

export function slotToSheetMeal(slot: MealSlot): SheetMealRow['meal'] {
  switch (slot) {
    case 'breakfast':
      return 'Breakfast';
    case 'lunch':
      return 'Lunch';
    case 'dinner':
      return 'Dinner';
    case 'snack':
      return 'Snack';
  }
}

export function libraryItemToRow(item: LibraryItem): SheetLibraryItem {
  return {
    entryId: item.id,
    name: item.name.trim(),
    serving: item.serving.trim(),
    kcal: round0(item.macros.kcal),
    proteinG: round0(item.macros.proteinG),
    carbsG: round0(item.macros.carbsG),
    fatG: round0(item.macros.fatG),
    aliases: normalizeAliases(item.aliases),
    addedBy: item.addedBy,
    uses: Math.max(0, round0(item.uses)),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

/**
 * Sheet rows may be typed by hand: numbers can arrive as strings, aliases as one
 * comma-separated string, and Entry ID may be blank (then the id is derived from the
 * name so repeated pulls map to the same local item).
 */
export function libraryItemFromRow(row: SheetLibraryItem): LibraryItem {
  const name = String(row.name ?? '').trim();
  const entryId = String(row.entryId ?? '').trim();
  const updatedAt = Date.parse(String(row.updatedAt ?? ''));
  return {
    id: entryId || libraryIdFromName(name),
    name,
    serving: String(row.serving ?? '').trim(),
    macros: {
      kcal: toNumber(row.kcal),
      proteinG: toNumber(row.proteinG),
      carbsG: toNumber(row.carbsG),
      fatG: toNumber(row.fatG),
    },
    aliases: normalizeAliases(row.aliases as unknown),
    addedBy: String(row.addedBy ?? '').trim(),
    uses: Math.max(0, Math.round(toNumber(row.uses))),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    synced: true,
  };
}

/** Stable id for a hand-typed library row without an Entry ID. */
export function libraryIdFromName(name: string): string {
  return `name:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizeAliases(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(list.map((a) => a.trim()).filter(Boolean))];
}
