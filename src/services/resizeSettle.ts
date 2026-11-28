import { useSyncExternalStore } from 'react';

/**
 * Going in or out of full screen resizes the window in several steps (Windows drops the title bar,
 * then grows the window to the screen; macOS animates). The player's controls are laid out for
 * each step, so they flashed and jumped around the screen. While the window settles they're hidden,
 * and they come back once, laid out at the final size.
 */

/** No resize for this long: the window has its final size. */
export const SETTLE_QUIET_MS = 150;
/** After asking for full screen, the first resize can take this long to arrive. */
export const SETTLE_FIRST_RESIZE_MS = 600;
/** Never hide the controls for longer than this. */
export const SETTLE_MAX_MS = 2000;

type Clock = { now: () => number; set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };

export function createResizeSettle(clock: Clock) {
  let settling = false;
  let timer: unknown = null;
  let startedAt = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());

  const end = () => {
    if (timer != null) clock.clear(timer);
    timer = null;
    if (!settling) return;
    settling = false;
    emit();
  };
  const wait = (ms: number) => {
    if (timer != null) clock.clear(timer);
    timer = clock.set(end, Math.max(0, Math.min(ms, startedAt + SETTLE_MAX_MS - clock.now())));
  };

  return {
    /** Call right before asking the window to change size (hides the controls first). */
    begin() {
      startedAt = clock.now();
      if (!settling) {
        settling = true;
        emit();
      }
      wait(SETTLE_FIRST_RESIZE_MS);
    },
    /** The window was resized (also by the OS: a full-screen exit from the title bar or a shortcut). */
    resized() {
      if (!settling) {
        startedAt = clock.now();
        settling = true;
        emit();
      }
      wait(SETTLE_QUIET_MS);
    },
    end,
    settling: () => settling,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export const resizeSettle = createResizeSettle({
  now: () => performance.now(),
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id as number),
});

let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('resize', () => resizeSettle.resized());
}

/** Whether the player's controls should stay hidden because the window is still changing size. */
export function useResizeSettling(): boolean {
  listen();
  return useSyncExternalStore(resizeSettle.subscribe, resizeSettle.settling);
}
