import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { IS_WINDOWS } from '../lib/platform';

/**
 * Player chrome visibility: `active` turns false after `ms` without a wake-up. Mouse moves over a
 * web player frame never reach the app, so players cover the frames with an idle shield (which
 * also hides the cursor, see `useHideFrameCursor`) and wake on the first move over it.
 */
export default function useIdle(ms = 3000) {
  const [active, setActive] = useState(true);
  const timer = useRef<number>();
  const wake = useCallback(() => {
    setActive(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setActive(false), ms);
  }, [ms]);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, [wake]);
  return { active, wake };
}

/** Where the mouse was resting when the shield went up, and until when every move is ignored. */
let parked: { x: number; y: number; until: number } | null = null;

/**
 * Hides the cursor over a web player while `shielded` (its idle shield is up). On Windows the
 * frame runs in its own process and keeps showing its cursor until the mouse moves, so a resting
 * mouse never lost it: the app moves the mouse by a pixel, which hands the cursor to the shield.
 */
export function useHideFrameCursor(shielded: boolean) {
  useEffect(() => {
    if (!shielded || !IS_WINDOWS) return;
    parked = { x: Number.NaN, y: Number.NaN, until: performance.now() + 400 };
    let current = true;
    invoke<[number, number] | null>('cursor_nudge')
      .then((at) => {
        if (current && at && parked) parked = { ...parked, x: at[0], y: at[1] };
      })
      .catch(() => {});
    return () => {
      current = false;
      parked = null;
    };
  }, [shielded]);
}

/** True for a mouse move that is only that nudge (or a pixel of jitter), not the user moving it. */
export function isCursorNudge(event: { clientX: number; clientY: number }) {
  if (!parked) return false;
  if (performance.now() < parked.until) return true;
  return Math.abs(event.clientX - parked.x) <= 3 && Math.abs(event.clientY - parked.y) <= 3;
}
