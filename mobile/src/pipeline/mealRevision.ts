/**
 * Pure rules for updating an existing meal with a new estimate (review: Re-estimate / merge;
 * pipeline: photos added to a meal still in review). No native imports, so Jest can test it.
 * OWNER: nutrition/pipeline builder.
 */
import type { ClarifyingQuestion, EntryStatus, MealEntry, MealEstimate } from '../types';

/** Statuses meaning the row is in the sheet (or on its way). */
const SHEET_STATUSES: readonly EntryStatus[] = ['approved', 'synced', 'sync_error'];

/**
 * True when the meal's row may be in the Food Log, so rejecting it must delete the row: its status
 * says so, or it reached the sheet before a re-estimate / merge moved it back to needs_review.
 */
export function mealMayBeInSheet(meal: MealEntry): boolean {
  return meal.inSheet === true || SHEET_STATUSES.includes(meal.status);
}

/** The meal's answered clarifying questions, as sent to the model. */
export function answeredQuestions(meal: MealEntry): { question: string; answer: string }[] {
  return (meal.estimate?.questions ?? []).flatMap((q) => {
    const answer = meal.answers[q.id]?.trim();
    return answer ? [{ question: q.question, answer }] : [];
  });
}

/** Question text for de-duplication (case, spacing and trailing punctuation ignored). */
export function questionKey(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\s?.!:]+$/, '');
}

/** First `q<n>` id not in `taken`. */
export function freeQuestionId(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const id = `q${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Answered questions stay listed (with their answers) next to the new estimate's questions.
 * Every estimate numbers its questions from q1, so a new question is matched against the old
 * ones by its text only, and one whose id is already used (by a carried question or an answer
 * key) gets a free id — it must neither disappear nor look answered.
 */
export function carryAnsweredQuestions(meal: MealEntry, next: MealEstimate): MealEstimate {
  const answered = (meal.estimate?.questions ?? []).filter((q) => meal.answers[q.id]?.trim());
  const seen = new Set(answered.map((q) => questionKey(q.question)));
  const taken = new Set([...answered.map((q) => q.id), ...Object.keys(meal.answers)]);
  const fresh: ClarifyingQuestion[] = [];
  for (const q of next.questions) {
    const key = questionKey(q.question);
    if (seen.has(key)) continue;
    seen.add(key);
    const id = taken.has(q.id) ? freeQuestionId(taken) : q.id;
    taken.add(id);
    fresh.push(id === q.id ? q : { ...q, id });
  }
  return { ...next, questions: [...answered, ...fresh] };
}

/** Answers of questions that are still listed (a stale key could later attach to a new question). */
export function answersFor(questions: ClarifyingQuestion[], answers: Record<string, string>): Record<string, string> {
  const ids = new Set(questions.map((q) => q.id));
  return Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id)));
}

/**
 * Pure: `meal` with a fresh estimate from its photos, notes and answers. It goes back to
 * needs_review; a meal that may already be in the sheet keeps that fact (`inSheet`), so rejecting
 * it later still deletes its row. A title the user typed is kept.
 */
export function withNewEstimate(meal: MealEntry, estimate: MealEstimate, now: number): MealEntry {
  const carried = carryAnsweredQuestions(meal, estimate);
  const titleEdited = meal.estimate !== null && meal.title !== meal.estimate.title;
  return {
    ...meal,
    estimate: carried,
    answers: answersFor(carried.questions, meal.answers),
    final: { ...estimate.totals },
    title: titleEdited ? meal.title : estimate.title,
    status: 'needs_review',
    error: null,
    updatedAt: now,
    ...(mealMayBeInSheet(meal) ? { inSheet: true } : {}),
  };
}
