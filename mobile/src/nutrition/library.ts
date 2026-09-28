/** Food Library matching. Pure. OWNER: nutrition/pipeline builder. */
import type { LibraryItem } from '../types';

/**
 * Pre-filter library items worth showing to the model: most-used first, plus any whose
 * name/aliases share a word with `hint` (user notes). At most `limit` (default 30).
 */
export function libraryCandidates(library: LibraryItem[], hint: string, limit?: number): LibraryItem[] {
  throw new Error('not implemented');
}
