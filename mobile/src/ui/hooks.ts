/** Shared React hooks for screens. */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getSettings, subscribeSettings } from '../config/settings';
import { getPhotos } from '../db/photos';
import { errorMessage } from '../lib/log';
import { createActionRunner } from './actionRunner';
import type { AppSettings } from '../types';

/** Ref that is true while the component is mounted (async results must not set state after). */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** Keeps the latest value in a ref without re-running effects that read it. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface SettingsState {
  settings: AppSettings | null;
  error: string | null;
  reload: () => void;
}

/** Current settings (null until loaded), kept fresh via subscribeSettings. */
export function useSettingsState(): SettingsState {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeSettings((next) => {
      if (active) setSettings(next);
    });
    getSettings().then(
      (loaded) => {
        if (!active) return;
        setSettings((current) => current ?? loaded);
        setError(null);
      },
      (e: unknown) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { settings, error, reload };
}

export function useSettings(): AppSettings | null {
  return useSettingsState().settings;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  /** True while any load (first or reload) is running. */
  loading: boolean;
  /** Resolves when the load finishes; never rejects (errors land in `error`). */
  reload: () => Promise<void>;
  setData: (update: T | ((prev: T | undefined) => T)) => void;
}

/**
 * Runs `fn` on mount and whenever `key` changes; only the newest request may set state.
 * Previous data stays visible while reloading (pull-to-refresh, focus refresh).
 */
export function useAsync<T>(fn: () => Promise<T>, key: unknown = null): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useLatest(fn);
  const mountedRef = useMounted();
  const requestIdRef = useRef(0);

  // A new key starts a new load: show it as loading right away (state adjusted during render,
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [loadedKey, setLoadedKey] = useState(key);
  if (!Object.is(loadedKey, key)) {
    setLoadedKey(key);
    setLoading(true);
  }

  /** Runs `fn`; state is only set once it settles, and only by the newest request. */
  const load = useCallback(async () => {
    const id = ++requestIdRef.current;
    try {
      const result = await fnRef.current();
      if (mountedRef.current && id === requestIdRef.current) {
        setDataState(() => result);
        setError(null);
      }
    } catch (e) {
      if (mountedRef.current && id === requestIdRef.current) setError(errorMessage(e));
    } finally {
      if (mountedRef.current && id === requestIdRef.current) setLoading(false);
    }
  }, [fnRef, mountedRef]);

  const reload = useCallback(async () => {
    setLoading(true);
    await load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, key]);

  const setData = useCallback((update: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof update === 'function' ? (update as (p: T | undefined) => T)(prev) : update));
  }, []);

  return { data, error, loading, reload, setData };
}

/**
 * Current time (ms) for render-time labels ("2 hours ago", "Today"), refreshed every `intervalMs`.
 * Keeps `Date.now()` out of render so components stay pure.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Editable local copy of `source` (a text field's draft) that resets whenever `source` changes,
 * e.g. after a re-estimate replaces the stored value. Uses React's "adjust state when a prop
 * changes" pattern instead of an effect.
 */
export function useDraft<T>(source: T): [T, (next: T) => void] {
  const [draft, setDraft] = useState(source);
  const [seen, setSeen] = useState(source);
  if (!Object.is(seen, source)) {
    setSeen(source);
    setDraft(source);
  }
  return [draft, setDraft];
}

/** Calls `reload` whenever the screen regains focus (not on the first focus — useAsync already loaded). */
export function useFocusRefresh(reload: () => unknown): void {
  const reloadRef = useLatest(reload);
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      void reloadRef.current();
    }, [reloadRef]),
  );
}

export interface ActionState<A extends unknown[], R> {
  /** Never rejects: failures set `error`; resolves undefined when it failed or was already running. */
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: string | null;
  setError: (message: string | null) => void;
}

export interface ActionOptions {
  /**
   * Queue calls made while one is running instead of ignoring them (for edits that must all
   * land, e.g. a title saved on blur followed by a quick slot change).
   */
  serial?: boolean;
}

/** Loading + inline error state for one user action (a button). Ignores double taps unless `serial`. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, options: ActionOptions = {}): ActionState<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useLatest(fn);
  const mounted = useMounted();
  const serial = options.serial === true;
  const [runner] = useState(() =>
    createActionRunner(serial, {
      onBusy: (busy) => {
        if (mounted.current) setPending(busy);
      },
      onError: (message) => {
        if (mounted.current) setError(message);
      },
    }),
  );

  const run = useCallback((...args: A) => runner(() => fnRef.current(...args)), [runner, fnRef]);
  return { run, pending, error, setError };
}

/** assetId → displayable URI for the photos the pipeline knows about. */
export async function loadPhotoUris(assetIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(assetIds)];
  if (unique.length === 0) return {};
  const records = await getPhotos(unique);
  return Object.fromEntries(records.map((r) => [r.assetId, r.uri]));
}
