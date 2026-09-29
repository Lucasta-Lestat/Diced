/** Food Library matching. Pure. OWNER: nutrition/pipeline builder. */
import type { LibraryItem } from '../types';
import { words } from './text';

export const DEFAULT_LIBRARY_CANDIDATES = 30;

/** Uses known to the sheet plus this phone's not yet synced ones. */
const totalUses = (item: LibraryItem) => item.uses + (item.pendingUses ?? 0);

function byUse(a: LibraryItem, b: LibraryItem): number {
  return (
    totalUses(b) - totalUses(a) ||
    b.updatedAt - a.updatedAt ||
    a.name.localeCompare(b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function sharesWord(item: LibraryItem, hint: Set<string>): boolean {
  return [item.name, ...item.aliases].some((text) => words(text).some((w) => hint.has(w)));
}

/**
 * Pre-filter library items worth showing to the model: most-used first, plus any whose
 * name/aliases share a word with `hint` (user notes). At most `limit` (default 30).
 * Hint matches come first so a rarely used item the user mentioned is never cut off.
 */
export function libraryCandidates(library: LibraryItem[], hint: string, limit?: number): LibraryItem[] {
  const max = Math.max(0, Math.floor(limit ?? DEFAULT_LIBRARY_CANDIDATES));
  const unique = [...new Map(library.map((item) => [item.id, item])).values()];
  const hintWords = new Set(words(hint));
  const matches: LibraryItem[] = [];
  const rest: LibraryItem[] = [];
  for (const item of unique) (hintWords.size > 0 && sharesWord(item, hintWords) ? matches : rest).push(item);
  return [...matches.sort(byUse), ...rest.sort(byUse)].slice(0, max);
}
