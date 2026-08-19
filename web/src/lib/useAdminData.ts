import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

interface Loaded<T> {
  data: T | null;
  error: string | null;
  /** True only for the *first* load. A poll refreshing in the background must
   *  not blank the page the operator is reading. */
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Loads admin data, optionally on an interval.
 *
 * Two behaviours the admin pages depend on and that a naive fetch-in-useEffect
 * gets wrong: a background refresh keeps the previous data on screen instead of
 * flashing a spinner, and a response that arrives after its request was
 * superseded is discarded rather than overwriting newer data.
 */
export function useAdminData<T>(
  fetcher: () => Promise<T>,
  { intervalMs, key }: { intervalMs?: number | null; key?: string } = {},
): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Identifies the newest in-flight request, so a slow earlier one cannot land
  // on top of a fast later one.
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async (background: boolean) => {
    const mine = ++generation.current;
    if (background) setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (mine !== generation.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (mine === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load(false);
    // `key` is the caller's declaration of what the fetcher depends on — the
    // serialised filters. Re-running on it keeps the fetcher out of the dep
    // array, where a fresh closure every render would loop forever.
  }, [key, nonce, load]);

  useEffect(() => {
    if (!intervalMs) return;
    const timer = setInterval(() => void load(true), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, key, load]);

  return { data, error, loading, refreshing, refresh: () => setNonce((n) => n + 1) };
}

/**
 * Filter state that lives in the URL.
 *
 * Every list view in the console needs to be linkable — "here is the exact
 * activity view showing the failures" is most of the value of having filters at
 * all — and URL-backed state also survives a refresh and the back button for
 * free.
 */
export function useUrlFilters<T extends Record<string, string>>(defaults: T) {
  const [params, setParams] = useSearchParams();

  const values = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const fromUrl = params.get(String(key));
    if (fromUrl !== null) values[key] = fromUrl as T[keyof T];
  }

  const set = useCallback(
    (patch: Partial<T>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(patch)) {
        // A value back at its default is absent from the URL, so a shared link
        // carries only the filters someone actually chose.
        if (value === undefined || value === "" || value === defaults[key]) next.delete(key);
        else next.set(key, String(value));
      }
      // Any filter change invalidates the current page.
      if (!("offset" in patch)) next.delete("offset");
      setParams(next, { replace: true });
    },
    [params, setParams, defaults],
  );

  return [values, set] as const;
}
