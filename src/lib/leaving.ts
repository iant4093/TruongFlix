import { useEffect, useState } from 'react';

/**
 * Keeps something on screen for a moment after it closes, so it can play its closing animation
 * (an `nf-closing` class on its root turns its entrance classes into exits; see index.css).
 *
 * `value` is what's showing (a flag, or the data the overlay shows); falsy means closed. Returns
 * what to render (the last value while it's leaving) and whether it's leaving.
 */
export function useLeaving<T>(value: T | null | undefined | false, ms = 280): { shown: T | null; closing: boolean } {
  const [last, setLast] = useState<T | null>(value || null);
  useEffect(() => {
    if (value) {
      setLast(value);
      return;
    }
    const t = window.setTimeout(() => setLast(null), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  if (value) return { shown: value, closing: false };
  return { shown: last, closing: last != null };
}

/** The class that plays an element's exit (see `useLeaving`). */
export const leavingClass = (closing: boolean) => (closing ? 'nf-closing' : '');
