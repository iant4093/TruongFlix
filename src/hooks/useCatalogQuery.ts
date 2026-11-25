import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../lib/errors';

/** Answers kept for the session, so going back and forth in Browse → Music is instant. */
const memory = new Map<string, unknown>();
/** Requests on their way, shared by everything asking for the same key. */
const inflight = new Map<string, Promise<unknown>>();
const MAX = 200;

function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  let job = inflight.get(key) as Promise<T> | undefined;
  if (!job) {
    job = load().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

/**
 * Loads `load()` for `key` (null: nothing to load) and keeps the answer for the session.
 * Changing the key shows the new answer's loading state, never the old answer.
 */
export default function useCatalogQuery<T>(key: string | null, load: () => Promise<T>) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string }>(() => ({
    key,
    data: key && memory.has(key) ? (memory.get(key) as T) : null,
    error: '',
  }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) {
      setState({ key, data: null, error: '' });
      return;
    }
    if (memory.has(key) && attempt === 0) {
      setState({ key, data: memory.get(key) as T, error: '' });
      return;
    }
    let alive = true;
    setState((s) => (s.key === key && !s.error ? s : { key, data: null, error: '' }));
    shared(key, load)
      .then((data) => {
        if (!alive) return;
        if (memory.size >= MAX) memory.delete(memory.keys().next().value!);
        memory.set(key, data);
        setState({ key, data, error: '' });
      })
      .catch((e) => alive && setState({ key, data: null, error: errorMessage(e) }));
    return () => {
      alive = false;
    };
    // `load` is a fresh closure each render; the key says when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  const current = state.key === key;
  const retry = useCallback(() => {
    if (key) memory.delete(key);
    setAttempt((n) => n + 1);
  }, [key]);
  return {
    data: current ? state.data : null,
    error: current ? state.error : '',
    loading: !!key && (!current || (!state.data && !state.error)),
    retry,
  };
}
