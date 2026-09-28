/// <reference types="jest" />
import { createActionRunner } from '../actionRunner';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(serial: boolean) {
  const busy: boolean[] = [];
  const errors: (string | null)[] = [];
  const run = createActionRunner(serial, { onBusy: (b) => busy.push(b), onError: (e) => errors.push(e) });
  return { run, busy, errors };
}

describe('createActionRunner', () => {
  it('reports busy and returns the result', async () => {
    const { run, busy, errors } = setup(false);
    await expect(run(async () => 42)).resolves.toBe(42);
    expect(busy).toEqual([true, false]);
    expect(errors).toEqual([null]);
  });

  it('turns failures into an error message instead of rejecting', async () => {
    const { run, busy, errors } = setup(false);
    await expect(run(async () => Promise.reject(new Error('Sheet unreachable')))).resolves.toBeUndefined();
    expect(errors).toEqual([null, 'Sheet unreachable']);
    expect(busy.at(-1)).toBe(false);
  });

  it('ignores a second call while one is running (double tap)', async () => {
    const { run } = setup(false);
    const gate = deferred<string>();
    const calls: string[] = [];
    const first = run(async () => {
      calls.push('first');
      return gate.promise;
    });
    const second = run(async () => {
      calls.push('second');
      return 'second';
    });
    await expect(second).resolves.toBeUndefined();
    gate.resolve('first');
    await expect(first).resolves.toBe('first');
    expect(calls).toEqual(['first']);
    // Free again afterwards.
    await expect(run(async () => 'third')).resolves.toBe('third');
  });

  it('queues calls in order when serial, staying busy until the last finishes', async () => {
    const { run, busy } = setup(true);
    const gate = deferred<void>();
    const order: string[] = [];
    const a = run(async () => {
      await gate.promise;
      order.push('a');
      return 'a';
    });
    const b = run(async () => {
      order.push('b');
      return 'b';
    });
    expect(busy).toEqual([true, true]);
    gate.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a', 'b']);
    expect(busy).toEqual([true, true, false]);
  });

  it('keeps the queue going after a failure', async () => {
    const { run, errors } = setup(true);
    const a = run(async () => {
      throw new Error('first failed');
    });
    const b = run(async () => 'ok');
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBe('ok');
    expect(errors).toContain('first failed');
  });
});
