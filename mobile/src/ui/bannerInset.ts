/**
 * Height of the pinned footer (Approve / Reject…) on the focused screen, so the floating auto-run
 * banner in the root layout can sit above it instead of covering its buttons. Pure module (no
 * native imports). Keyed per Screen so one screen's cleanup never clears another's value.
 */

const heights = new Map<number, number>();
const listeners = new Set<() => void>();
let nextKey = 1;
let current = 0;

function emit(): void {
  const next = heights.size ? Math.max(...heights.values()) : 0;
  if (next === current) return;
  current = next;
  for (const l of [...listeners]) l();
}

/** A key for one Screen instance. */
export function newFooterKey(): number {
  return nextKey++;
}

export function setFooterInset(key: number, height: number): void {
  const h = Number.isFinite(height) && height > 0 ? Math.round(height) : 0;
  if (h > 0) heights.set(key, h);
  else heights.delete(key);
  emit();
}

export function clearFooterInset(key: number): void {
  heights.delete(key);
  emit();
}

/** Footer height (pt) the banner has to clear; 0 when the focused screen has no footer. */
export function getFooterInset(): number {
  return current;
}

export function subscribeFooterInset(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only. */
export function __resetFooterInsetForTests(): void {
  heights.clear();
  listeners.clear();
  current = 0;
}
