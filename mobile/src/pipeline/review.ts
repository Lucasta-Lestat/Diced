/**
 * Review actions used by the UI. OWNER: nutrition/pipeline builder.
 */
import { getSettings } from '../config/settings';
import { incrementLibraryUse, listLibrary, upsertLibraryItem } from '../db/library';
import { addPendingSheetDelete, deleteMeal, getMeal, listMeals, upsertMeal } from '../db/meals';
import { getPhotos } from '../db/photos';
import { getWeightEntry, listWeightEntries, recentAcceptedWeights, upsertWeightEntry } from '../db/weights';
import { isValidLocalDate, toLocalTime } from '../lib/dates';
import { newId, weightEntryId } from '../lib/ids';
import { errorMessage, logger } from '../lib/log';
import { rescaleRange, sumMacros } from '../nutrition/reconcile';
import type {
  ClarifyingQuestion,
  Confidence,
  EntryStatus,
  FoodItem,
  LibraryItem,
  Macros,
  MealEntry,
  MealEstimate,
  MealSlot,
  PersonLabel,
  WeightEntry,
} from '../types';
import { withWeightLock } from './concurrency';
import { isConfidentMeal, isConfidentWeight, MAX_MACRO_G, MAX_MEAL_KCAL } from './confidence';
import { estimateAndReconcile, loadMealImages } from './mealEstimate';
import {
  answeredQuestions,
  answersFor,
  freeQuestionId,
  mealMayBeInSheet,
  questionKey,
  withNewEstimate,
} from './mealRevision';
import { assessReading, isPlausibleLb, MAX_PLAUSIBLE_LB, MIN_PLAUSIBLE_LB, sourceForAsset } from './weights';

/** Pure approve-all rules (shared with the Review screen's count). */
export { isConfidentMeal, isConfidentWeight };

/** Statuses meaning the row is in the sheet (or on its way) — rejecting it must delete the row. */
const IN_SHEET: readonly EntryStatus[] = ['approved', 'synced', 'sync_error'];
const RECENT_WEIGHT_DAYS = 30;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const log = logger('review');

const round1 = (n: number) => Math.round(n * 10) / 10;

/** An accepted entry the user changes goes back to `approved` so the next sync rewrites its row. */
export function statusAfterEdit(status: EntryStatus): EntryStatus {
  if (status === 'synced' || status === 'sync_error') return 'approved';
  if (status === 'rejected') return 'needs_review';
  return status;
}

async function requirePerson(): Promise<PersonLabel> {
  const { person } = await getSettings();
  if (!person) throw new Error('Choose who this phone logs for (Her or Him) in Settings first.');
  return person;
}

// ---------------------------------------------------------------------------
// Weigh-ins
// ---------------------------------------------------------------------------

async function requireWeight(id: string): Promise<WeightEntry> {
  const entry = await getWeightEntry(id);
  if (!entry) throw new Error('That weigh-in no longer exists.');
  return entry;
}

function checkedWeight(valueLb: number): number {
  if (!isPlausibleLb(valueLb)) throw new Error(`Enter a weight between ${MIN_PLAUSIBLE_LB} and ${MAX_PLAUSIBLE_LB} lb.`);
  return round1(valueLb);
}

export async function approveWeight(id: string, valueLb?: number, notes?: string): Promise<WeightEntry> {
  return withWeightLock(async () => {
    const entry = await requireWeight(id);
    const value = valueLb ?? entry.valueLb;
    if (value === null) throw new Error('Enter a weight before approving.');
    const updated: WeightEntry = {
      ...entry,
      valueLb: checkedWeight(value),
      notes: notes ?? entry.notes,
      status: 'approved',
      syncError: null,
      updatedAt: Date.now(),
    };
    await upsertWeightEntry(updated);
    return updated;
  });
}

/**
 * Choose a different candidate reading for the day. The choice is remembered (`chosenByUser`), so
 * a later run that reads another photo of that day doesn't switch back to its automatic pick.
 */
export async function chooseWeightCandidate(id: string, assetId: string): Promise<WeightEntry> {
  return withWeightLock(async () => {
    const entry = await requireWeight(id);
    const chosen = entry.candidates.find((c) => c.assetId === assetId);
    if (!chosen) throw new Error("That photo isn't one of this day's readings.");
    // An accepted day goes straight back to the sheet, which rejects values outside its bounds
    // (and would fail the whole sync batch with it); a day still in review is checked on approve.
    if (IN_SHEET.includes(entry.status) && !isPlausibleLb(chosen.valueLb)) {
      throw new Error(
        `That reading (${round1(chosen.valueLb)} lb) is outside ${MIN_PLAUSIBLE_LB}–${MAX_PLAUSIBLE_LB} lb — type the weight instead.`,
      );
    }
    const settings = await getSettings();
    const recent = await recentAcceptedWeights(entry.person, entry.localDate, RECENT_WEIGHT_DAYS);
    const history = recent.flatMap((e) => (e.valueLb === null ? [] : [{ localDate: e.localDate, valueLb: e.valueLb }]));
    const { flags, confidence } = assessReading(entry.candidates, chosen, history, {
      morningCutoffHour: settings.morningCutoffHour,
      expectedUnit: settings.scaleUnit,
    });
    const updated: WeightEntry = {
      ...entry,
      valueLb: round1(chosen.valueLb),
      time: toLocalTime(chosen.takenAt),
      chosenAssetId: chosen.assetId,
      source: sourceForAsset(chosen.assetId),
      flags,
      confidence,
      status: statusAfterEdit(entry.status),
      updatedAt: Date.now(),
      chosenByUser: true,
    };
    await upsertWeightEntry(updated);
    return updated;
  });
}

export async function rejectWeight(id: string): Promise<void> {
  await withWeightLock(async () => {
    const entry = await requireWeight(id);
    if (IN_SHEET.includes(entry.status)) await addPendingSheetDelete(entry.id, 'weight');
    await upsertWeightEntry({ ...entry, status: 'rejected', syncError: null, updatedAt: Date.now() });
  });
}

/** Typed weigh-in: becomes that day's official (approved) entry, keeping any photo readings for reference. */
export async function addManualWeight(localDate: string, valueLb: number, notes: string): Promise<WeightEntry> {
  if (!isValidLocalDate(localDate)) throw new Error('Pick a valid date.');
  const value = checkedWeight(valueLb);
  const person = await requirePerson();
  return withWeightLock(async () => {
    const id = weightEntryId(person, localDate);
    const existing = await getWeightEntry(id);
    const entry: WeightEntry = {
      id,
      person,
      localDate,
      time: null,
      valueLb: value,
      chosenAssetId: null,
      source: 'manual',
      confidence: 'high',
      candidates: existing?.candidates ?? [],
      flags: [],
      notes: notes.trim(),
      status: 'approved',
      syncError: null,
      updatedAt: Date.now(),
    };
    await upsertWeightEntry(entry);
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

export interface MealEdit {
  title?: string;
  slot?: MealSlot;
  time?: string;
  final?: Macros;
  notes?: string;
  answers?: Record<string, string>;
  /** Replace item grams (by index); totals are recomputed from items when given. */
  itemGrams?: Record<number, number>;
}

async function requireMeal(id: string): Promise<MealEntry> {
  const meal = await getMeal(id);
  if (!meal) throw new Error('That meal no longer exists.');
  return meal;
}

function checkedMacros(m: Macros): Macros {
  const values = [m.kcal, m.proteinG, m.carbsG, m.fatG];
  if (!values.every((v) => Number.isFinite(v) && v >= 0)) throw new Error('Calories and macros must be zero or more.');
  if (m.kcal > MAX_MEAL_KCAL) throw new Error(`A meal can't be more than ${MAX_MEAL_KCAL.toLocaleString('en-US')} kcal.`);
  if (m.proteinG > MAX_MACRO_G || m.carbsG > MAX_MACRO_G || m.fatG > MAX_MACRO_G) {
    throw new Error(`Protein, carbs and fat can't be more than ${MAX_MACRO_G.toLocaleString('en-US')} g each.`);
  }
  return { kcal: Math.round(m.kcal), proteinG: round1(m.proteinG), carbsG: round1(m.carbsG), fatG: round1(m.fatG) };
}

function checkedTime(time: string): string {
  if (!TIME_PATTERN.test(time)) throw new Error('Time must look like 13:45.');
  return time;
}

/**
 * Pure: new grams for items (by index), each item's macros rescaled from its current grams;
 * totals and the kcal range follow. Items without known grams only get the grams recorded.
 */
export function applyItemGrams(estimate: MealEstimate, itemGrams: Record<number, number>): MealEstimate {
  const items = estimate.items.map((item, index): FoodItem => {
    const grams = itemGrams[index];
    if (grams === undefined) return item;
    if (!Number.isFinite(grams) || grams < 0) throw new Error('Grams must be zero or more.');
    if (item.grams === null || !(item.grams > 0)) return { ...item, grams };
    const f = grams / item.grams;
    return {
      ...item,
      grams,
      macros: {
        kcal: Math.round(item.macros.kcal * f),
        proteinG: round1(item.macros.proteinG * f),
        carbsG: round1(item.macros.carbsG * f),
        fatG: round1(item.macros.fatG * f),
      },
    };
  });
  const totals = sumMacros(items);
  const range = rescaleRange(estimate.kcalLow, estimate.kcalHigh, estimate.totals.kcal, totals.kcal);
  return { ...estimate, items, totals, kcalLow: range.low, kcalHigh: range.high };
}

/** Merged answers; an empty answer clears that question. */
function mergeAnswers(current: Record<string, string>, edit: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...current };
  for (const [id, answer] of Object.entries(edit)) {
    if (answer.trim()) out[id] = answer.trim();
    else delete out[id];
  }
  return out;
}

export async function editMeal(id: string, edit: MealEdit): Promise<MealEntry> {
  const meal = await requireMeal(id);
  let estimate = meal.estimate;
  let final = meal.final;
  if (edit.itemGrams && Object.keys(edit.itemGrams).length > 0) {
    if (!estimate) throw new Error('This meal has no items to edit.');
    estimate = applyItemGrams(estimate, edit.itemGrams);
    // Same bounds as typed totals: a grams typo (1400 g of oil) must not reach the sheet.
    final = checkedMacros(estimate.totals);
  }
  if (edit.final) final = checkedMacros(edit.final);
  const updated: MealEntry = {
    ...meal,
    title: edit.title !== undefined && edit.title.trim() ? edit.title.trim() : meal.title,
    slot: edit.slot ?? meal.slot,
    time: edit.time !== undefined ? checkedTime(edit.time) : meal.time,
    notes: edit.notes ?? meal.notes,
    answers: edit.answers ? mergeAnswers(meal.answers, edit.answers) : meal.answers,
    estimate,
    final,
    status: statusAfterEdit(meal.status),
    updatedAt: Date.now(),
  };
  await upsertMeal(updated);
  return updated;
}

async function loadLibraryQuietly(): Promise<LibraryItem[]> {
  try {
    return await listLibrary();
  } catch (e) {
    log.warn(`could not load the food library: ${errorMessage(e)}`);
    return [];
  }
}

/** The meal re-estimated from its photos, notes and answers (not saved). */
async function reestimated(meal: MealEntry): Promise<MealEntry> {
  const photos = await getPhotos(meal.assetIds);
  if (photos.length === 0) throw new Error('This meal has no photos to estimate from.');
  const { images } = await loadMealImages(photos);
  if (images.length === 0) throw new Error('The photos of this meal are no longer available.');
  const settings = await getSettings();
  const estimate = await estimateAndReconcile({
    images,
    slot: meal.slot,
    notes: meal.notes,
    answers: answeredQuestions(meal),
    library: await loadLibraryQuietly(),
    hint: `${meal.title} ${meal.notes}`,
    settings,
  });
  return withNewEstimate(meal, estimate, Date.now());
}

/** Throws unless every meal is still stored exactly as it was read (same updatedAt). */
/**
 * A meal was approved, edited, merged or deleted while a slow model call (re-estimate / merge)
 * ran, so the result was not saved. The screen should reload the meal and let the user retry.
 */
export class MealChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MealChangedError';
  }
}

async function requireUnchanged(meals: MealEntry[], message: string): Promise<void> {
  for (const meal of meals) {
    const current = await getMeal(meal.id);
    if (!current || current.updatedAt !== meal.updatedAt) throw new MealChangedError(message);
  }
}

/**
 * Re-run estimation with current notes + answers (+ reconcile). The meal goes back to
 * needs_review (a meal already in the sheet stays marked `inSheet`, so rejecting it later still
 * deletes its row). The model call can take a while: if the meal was approved or edited in the
 * meantime, nothing is saved and this throws.
 */
export async function reestimateMeal(id: string): Promise<MealEntry> {
  const meal = await requireMeal(id);
  const updated = await reestimated(meal);
  await requireUnchanged([meal], 'This meal changed while it was being re-estimated — check it and try again.');
  await upsertMeal(updated);
  return updated;
}

async function incrementUseQuietly(libraryItemId: string): Promise<void> {
  try {
    await incrementLibraryUse(libraryItemId);
  } catch (e) {
    log.warn(`could not count library use: ${errorMessage(e)}`);
  }
}

async function approve(meal: MealEntry): Promise<MealEntry> {
  const final = checkedMacros(meal.final);
  // Count a "usual meal" once, when a matched meal is first confirmed.
  const libraryItemId = meal.estimate?.libraryItemId;
  if (meal.status === 'needs_review' && libraryItemId) await incrementUseQuietly(libraryItemId);
  const updated: MealEntry = { ...meal, final, status: 'approved', error: null, updatedAt: Date.now() };
  await upsertMeal(updated);
  return updated;
}

export async function approveMeal(id: string): Promise<MealEntry> {
  return approve(await requireMeal(id));
}

/**
 * Reject (not food / not mine). If its row may be in the sheet — its status says so, or it was
 * synced before a re-estimate / merge put it back in review — queue a sheet delete.
 */
export async function rejectMeal(id: string): Promise<void> {
  const meal = await requireMeal(id);
  if (meal.status !== 'rejected' && mealMayBeInSheet(meal)) await addPendingSheetDelete(meal.id, 'meal');
  await upsertMeal({ ...meal, status: 'rejected', error: null, updatedAt: Date.now() });
}

function addMacros(a: Macros, b: Macros): Macros {
  return sumMacros([{ macros: a }, { macros: b }]);
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** A meal typed in by hand, as one item. */
function manualItem(meal: MealEntry): FoodItem {
  return {
    name: meal.title || 'Meal',
    portion: '1 serving',
    grams: null,
    macros: { ...meal.final },
    source: 'user',
    confidence: 'medium',
    usdaQuery: null,
    fdcId: null,
    modelMacros: null,
  };
}

/**
 * Pure: both meals' clarifying questions and answers in one list. Every estimate numbers its
 * questions from q1, so b's questions that collide with a's ids (or a's answer keys) get free ids
 * and b's answers move with them — otherwise a's answer would be taken as the answer to b's
 * different question. A question both meals ask is listed once (with whichever answer exists).
 */
export function combineQuestions(a: MealEntry, b: MealEntry): { questions: ClarifyingQuestion[]; answers: Record<string, string> } {
  const aQuestions = a.estimate?.questions ?? [];
  const questions = [...aQuestions];
  const answers = answersFor(aQuestions, a.answers);
  const byText = new Map(aQuestions.map((q) => [questionKey(q.question), q]));
  const taken = new Set([...aQuestions.map((q) => q.id), ...Object.keys(a.answers)]);
  for (const q of b.estimate?.questions ?? []) {
    const answer = b.answers[q.id]?.trim();
    const key = questionKey(q.question);
    const same = byText.get(key);
    if (same) {
      if (answer && !answers[same.id]?.trim()) answers[same.id] = answer;
      continue;
    }
    const id = taken.has(q.id) ? freeQuestionId(taken) : q.id;
    taken.add(id);
    const moved = id === q.id ? q : { ...q, id };
    questions.push(moved);
    byText.set(key, moved);
    if (answer) answers[id] = answer;
  }
  return { questions, answers };
}

/** Pure: both meals' items in one estimate (used until / unless re-estimation succeeds). */
export function combineMeals(a: MealEntry, b: MealEntry, title: string, now: number): MealEstimate {
  const items = [...(a.estimate?.items ?? [manualItem(a)]), ...(b.estimate?.items ?? [manualItem(b)])];
  const range = (m: MealEntry) => ({
    low: m.estimate?.kcalLow ?? m.final.kcal,
    high: m.estimate?.kcalHigh ?? m.final.kcal,
  });
  const base = a.estimate ?? b.estimate;
  const confidences = [a, b].map((m) => m.estimate?.confidence ?? 'medium');
  return {
    title,
    items,
    totals: sumMacros(items),
    kcalLow: range(a).low + range(b).low,
    kcalHigh: range(a).high + range(b).high,
    confidence: confidences.reduce((x, y) => (CONFIDENCE_RANK[x] <= CONFIDENCE_RANK[y] ? x : y)),
    method: a.estimate?.method === b.estimate?.method && a.estimate ? a.estimate.method : 'photo',
    questions: combineQuestions(a, b).questions,
    assumptions: [...new Set([...(a.estimate?.assumptions ?? []), ...(b.estimate?.assumptions ?? [])])],
    libraryItemId: null,
    brand: a.estimate?.brand && a.estimate.brand === b.estimate?.brand ? a.estimate.brand : null,
    barcode: null,
    model: base?.model ?? '',
    samples: 1,
    createdAt: now,
  };
}

function earlier(a: MealEntry, b: MealEntry): MealEntry {
  return `${b.localDate} ${b.time}` < `${a.localDate} ${a.time}` ? b : a;
}

/**
 * Merge meal `b` into `a` (photos combined, re-estimated). The result is back in review; if `a`
 * was already in the sheet it stays marked `inSheet`, and `b`'s row is deleted. Nothing is saved
 * if either meal changed while the merge was re-estimating.
 */
export async function mergeMeals(aId: string, bId: string): Promise<MealEntry> {
  if (aId === bId) throw new Error("Can't merge a meal with itself.");
  const a = await requireMeal(aId);
  const b = await requireMeal(bId);
  const photos = await getPhotos([...new Set([...a.assetIds, ...b.assetIds])]);
  const photoTime = new Map(photos.map((p) => [p.assetId, p.creationTime]));
  const assetIds = [...new Set([...a.assetIds, ...b.assetIds])].sort(
    (x, y) => (photoTime.get(x) ?? 0) - (photoTime.get(y) ?? 0),
  );
  const first = earlier(a, b);
  const title = a.title === b.title ? a.title : `${a.title} + ${b.title}`;
  const now = Date.now();
  const merged: MealEntry = {
    ...a,
    localDate: first.localDate,
    time: first.time,
    slot: first.slot,
    assetIds,
    notes: [a.notes.trim(), b.notes.trim()].filter(Boolean).join('\n'),
    answers: combineQuestions(a, b).answers,
    estimate: combineMeals(a, b, title, now),
    final: addMacros(a.final, b.final),
    title,
    status: 'needs_review',
    error: null,
    updatedAt: now,
    ...(mealMayBeInSheet(a) ? { inSheet: true } : {}),
  };
  let result = merged;
  try {
    result = await reestimated(merged);
  } catch (e) {
    // The merge stands with the two estimates added up; the user can retry re-estimation.
    result = { ...merged, error: errorMessage(e) };
  }
  await requireUnchanged([a, b], 'These meals changed while they were being merged — check them and try again.');
  await upsertMeal(result);
  if (mealMayBeInSheet(b)) await addPendingSheetDelete(b.id, 'meal');
  await deleteMeal(b.id);
  return result;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Save the meal's final numbers as a Food Library item (shared via the sheet). */
export async function saveMealToLibrary(id: string, name: string, serving: string): Promise<void> {
  const meal = await requireMeal(id);
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give the usual meal a name.');
  const macros = checkedMacros(meal.final);
  const existing = (await loadLibraryQuietly()).find((item) => sameName(item.name, trimmed));
  const aliases = [...new Set([...(existing?.aliases ?? []), meal.title.trim()])].filter(
    (alias) => alias && !sameName(alias, trimmed),
  );
  // Approving a needs_review meal counts the use later (see approve), so don't count it twice.
  const counted = meal.status !== 'needs_review' && meal.estimate?.libraryItemId !== existing?.id ? 1 : 0;
  // An existing item's use is added to the sheet's count (pendingUses), not written over it.
  const pendingUses = (existing?.pendingUses ?? 0) + (existing ? counted : 0);
  const now = Date.now();
  const item: LibraryItem = {
    id: existing?.id ?? newId(),
    name: existing?.name ?? trimmed,
    serving: serving.trim() || existing?.serving || '',
    macros,
    aliases,
    addedBy: existing?.addedBy ?? meal.person,
    uses: existing ? existing.uses : counted,
    updatedAt: now,
    synced: false,
    ...(pendingUses > 0 ? { pendingUses } : {}),
  };
  await upsertLibraryItem(item);
  if (meal.estimate) {
    await upsertMeal({ ...meal, estimate: { ...meal.estimate, libraryItemId: item.id }, updatedAt: now });
  }
}

/** Approve every needs_review entry whose confidence is high and has no flags/questions. */
export async function approveAllConfident(): Promise<{ weights: number; meals: number }> {
  const { person } = await getSettings();
  const filter = { person: person ?? undefined, statuses: ['needs_review'] as EntryStatus[] };
  let weights = 0;
  for (const entry of await listWeightEntries(filter)) {
    if (!isConfidentWeight(entry)) continue;
    await approveWeight(entry.id);
    weights++;
  }
  let meals = 0;
  for (const meal of await listMeals(filter)) {
    if (!isConfidentMeal(meal)) continue;
    await approve(meal);
    meals++;
  }
  return { weights, meals };
}

export async function addManualMeal(
  localDate: string,
  time: string,
  slot: MealSlot,
  title: string,
  final: Macros,
  notes: string,
): Promise<MealEntry> {
  if (!isValidLocalDate(localDate)) throw new Error('Pick a valid date.');
  const meal: MealEntry = {
    id: newId(),
    person: await requirePerson(),
    localDate,
    time: checkedTime(time),
    slot,
    assetIds: [],
    // No estimate: the sheet row gets method "manual".
    estimate: null,
    final: checkedMacros(final),
    title: title.trim(),
    answers: {},
    notes: notes.trim(),
    status: 'approved',
    error: null,
    updatedAt: Date.now(),
  };
  await upsertMeal(meal);
  return meal;
}
