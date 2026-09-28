/** Small async helpers for the pipeline. Pure (no native imports). OWNER: nutrition/pipeline builder. */

/**
 * Runs `fn` over `items` with at most `limit` in flight. `shouldStop()` is checked before each
 * item starts; once true, nothing new starts and running items finish. Resolves with the number
 * of items started. If `fn` throws, the first error is rethrown after every worker has stopped.
 */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  let next = 0;
  let started = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && !failure && !shouldStop()) {
      const index = next++;
      started++;
      try {
        await fn(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return started;
}

/** A FIFO mutex: tasks run one at a time, in call order; a failed task doesn't block the next. */
export function createLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
}

/**
 * Serializes every read-modify-write of weight entries (pipeline merges vs. review edits), so
 * a run merging new readings into a day can't overwrite an approval made at the same moment.
 */
export const withWeightLock = createLock();
