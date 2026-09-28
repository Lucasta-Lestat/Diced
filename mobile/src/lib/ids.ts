import * as Crypto from 'expo-crypto';
import type { LocalDate, PersonLabel } from '../types';

/** Random uuid v4 (meal ids, library ids). */
export function newId(): string {
  return Crypto.randomUUID();
}

/** One official weigh-in per person per day → deterministic sheet Entry ID. */
export function weightEntryId(person: PersonLabel, date: LocalDate): string {
  return `w:${person}:${date}`;
}
