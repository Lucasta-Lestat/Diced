/** Food Library cache (table `library`). OWNER: data-layer builder. */
import type { LibraryItem } from '../types';

export async function listLibrary(): Promise<LibraryItem[]> {
  throw new Error('not implemented');
}

export async function getLibraryItem(id: string): Promise<LibraryItem | null> {
  throw new Error('not implemented');
}

export async function upsertLibraryItem(item: LibraryItem): Promise<void> {
  throw new Error('not implemented');
}

/**
 * Merge items fetched from the sheet: sheet wins unless the local copy is unsynced and
 * newer (updatedAt). Items missing from the sheet are kept only if unsynced.
 */
export async function mergeLibraryFromSheet(items: LibraryItem[]): Promise<void> {
  throw new Error('not implemented');
}

export async function listUnsyncedLibrary(): Promise<LibraryItem[]> {
  throw new Error('not implemented');
}

export async function markLibrarySynced(ids: string[]): Promise<void> {
  throw new Error('not implemented');
}

export async function incrementLibraryUse(id: string): Promise<void> {
  throw new Error('not implemented');
}
