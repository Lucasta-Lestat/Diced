/** Shared WHERE-clause builder for the weight_entries / meals tables (private to db/). */
import type { EntryStatus, LocalDate, PersonLabel } from '../types';
import { placeholders } from './database';

export interface EntryFilter {
  person?: PersonLabel;
  statuses?: EntryStatus[];
  from?: LocalDate;
  to?: LocalDate;
}

/** `WHERE …` (or '') plus positional params; `from`/`to` are inclusive. */
export function entryWhere(filter: EntryFilter | undefined): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.person !== undefined) {
    clauses.push('person = ?');
    params.push(filter.person);
  }
  if (filter?.statuses !== undefined) {
    if (filter.statuses.length === 0) return { sql: 'WHERE 0', params: [] };
    clauses.push(`status IN (${placeholders(filter.statuses.length)})`);
    params.push(...filter.statuses);
  }
  if (filter?.from !== undefined) {
    clauses.push('local_date >= ?');
    params.push(filter.from);
  }
  if (filter?.to !== undefined) {
    clauses.push('local_date <= ?');
    params.push(filter.to);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Parses a JSON `data` column; the indexed columns are copies of fields inside it. */
export function parseData<T>(data: string): T {
  return JSON.parse(data) as T;
}

/**
 * Error value to store for a status change: an explicit value wins; otherwise a
 * `sync_error` keeps the previous message and every other status clears it.
 */
export function statusErrorParams(
  status: EntryStatus,
  error: string | null | undefined,
): { keep: 0 | 1; value: string | null } {
  if (error !== undefined) return { keep: 0, value: error };
  return status === 'sync_error' ? { keep: 1, value: null } : { keep: 0, value: null };
}
