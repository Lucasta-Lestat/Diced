/**
 * Word-level text matching shared by USDA scoring, Food Library matching and barcode item
 * matching. Pure. OWNER: nutrition/pipeline builder.
 */

/** Words that carry no food identity in queries or database descriptions. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'made', 'no', 'not', 'ns',
  'of', 'on', 'or', 'other', 'style', 'the', 'to', 'type', 'with', 'without',
]);

/**
 * Preparation / state words. They refine a match but can't make one: "cooked rice" must not
 * match "cooked spinach" on the word "cooked" alone.
 */
const MODIFIERS = new Set([
  'baked', 'boiled', 'boneless', 'braised', 'breaded', 'broiled', 'canned', 'chopped', 'cooked',
  'diced', 'drained', 'dried', 'fresh', 'fried', 'frozen', 'grilled', 'homemade', 'large', 'lean',
  'medium', 'plain', 'poached', 'prepared', 'raw', 'regular', 'roasted', 'salted', 'sauteed',
  'scrambled', 'skinless', 'sliced', 'small', 'steamed', 'stewed', 'toasted', 'uncooked',
  'unsalted', 'whole',
]);

/** Lowercase, accents removed, punctuation → spaces, whitespace collapsed. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Crude singularisation, applied to both sides of every comparison so it only needs to be consistent. */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('oes')) return word.slice(0, -2);
  if (word.length > 4 && /(ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Meaningful, stemmed words of `text` (order kept, duplicates removed). */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(text).split(' ')) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const w = stem(raw);
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

export function isModifier(word: string): boolean {
  return MODIFIERS.has(word);
}

export interface WordMatch {
  /** Weighted share of the query's words found in the candidate (modifiers count half). */
  recall: number;
  /** Share of the candidate's words that were asked for (prefers specific descriptions). */
  precision: number;
  /** At least one non-modifier query word matched (or the query only has modifiers). */
  coreMatched: boolean;
}

export function matchWords(queryWords: string[], candidateText: string): WordMatch {
  const candidate = new Set(words(candidateText));
  let total = 0;
  let matched = 0;
  let hasCore = false;
  let coreMatched = false;
  for (const w of queryWords) {
    const modifier = isModifier(w);
    const weight = modifier ? 0.5 : 1;
    total += weight;
    if (!modifier) hasCore = true;
    if (candidate.has(w)) {
      matched += weight;
      if (!modifier) coreMatched = true;
    }
  }
  const hits = queryWords.filter((w) => candidate.has(w)).length;
  return {
    recall: total > 0 ? matched / total : 0,
    precision: candidate.size > 0 ? hits / candidate.size : 0,
    coreMatched: hasCore ? coreMatched : matched > 0,
  };
}
