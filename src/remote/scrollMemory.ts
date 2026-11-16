import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Where you were on each page of the browser app (and how far each row was scrolled sideways),
 * so coming back from a title, the player or Downloads lands in the same place.
 */
const pages = new Map<string, number>();
const rows = new Map<string, number>();

const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
const RESTORE_LIMIT_MS = 2000;
let stopRestore: (() => void) | null = null;

export function saveScroll(page: string) {
  pages.set(page, window.scrollY);
}

/**
 * Scrolls back to the page's remembered position. Content that's still loading can make the page
 * too short at first, so it keeps trying for a moment, until it gets there or you scroll yourself.
 */
export function restoreScroll(page: string) {
  stopRestore?.();
  const target = pages.get(page) ?? 0;
  window.scrollTo({ top: target, behavior: 'instant' });
  if (Math.abs(window.scrollY - target) < 2) return;
  const started = performance.now();
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of USER_INPUT) window.removeEventListener(type, stop, true);
    if (stopRestore === stop) stopRestore = null;
  };
  const attempt = () => {
    window.scrollTo({ top: target, behavior: 'instant' });
    if (Math.abs(window.scrollY - target) < 2 || performance.now() - started > RESTORE_LIMIT_MS) stop();
    else frame = requestAnimationFrame(attempt);
  };
  for (const type of USER_INPUT) window.addEventListener(type, stop, { capture: true, passive: true });
  stopRestore = stop;
  frame = requestAnimationFrame(attempt);
}

/** A sideways-scrolling row that remembers how far it was scrolled. */
export function useRowScroll(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const left = rows.get(key);
    if (el && left) el.scrollLeft = left;
  }, [key]);
  const onScroll = useCallback(() => {
    if (ref.current) rows.set(key, ref.current.scrollLeft);
  }, [key]);
  return { ref, onScroll };
}
