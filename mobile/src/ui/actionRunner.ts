/** Pure core of `useAction`: busy/error bookkeeping plus double-tap or queueing behaviour. */
import { errorMessage } from '../lib/log';

export interface RunnerCallbacks {
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
}

export type ActionRunner = <R>(task: () => Promise<R>) => Promise<R | undefined>;

/**
 * `serial: false` ignores a call made while another is running (double taps);
 * `serial: true` queues it so every call runs, in order. Never rejects.
 */
export function createActionRunner(serial: boolean, callbacks: RunnerCallbacks): ActionRunner {
  let running = 0;
  let queue: Promise<unknown> = Promise.resolve();

  return async function run<R>(task: () => Promise<R>): Promise<R | undefined> {
    if (running > 0 && !serial) return undefined;
    running += 1;
    callbacks.onBusy(true);
    callbacks.onError(null);
    const attempt = async (): Promise<R | undefined> => {
      try {
        return await task();
      } catch (e) {
        callbacks.onError(errorMessage(e));
        return undefined;
      }
    };
    const result = queue.then(attempt);
    queue = result;
    try {
      return await result;
    } finally {
      running -= 1;
      if (running === 0) callbacks.onBusy(false);
    }
  };
}
