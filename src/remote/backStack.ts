import { useEffect, useRef } from 'react';

/**
 * Overlays (the PC remote, the Live TV player) that the phone's Back button or swipe-back closes,
 * as in an app, instead of leaving the screen underneath. Each open overlay has a history entry;
 * the app's own Back handler asks `consumeBack()` first.
 */
const open: { close: () => void }[] = [];
let skip = 0;

/** For the app's popstate handler: true when the Back was an overlay's, so the screen stays. */
export function consumeBack(): boolean {
  if (skip > 0) {
    skip--;
    return true;
  }
  const top = open.pop();
  if (!top) return false;
  top.close();
  return true;
}

/** While `shown`, Back calls `close` (and closing it another way removes its history entry). */
export function useBackToClose(shown: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!shown) return;
    const entry = { close: () => latest.current() };
    open.push(entry);
    history.pushState({ tf: 'overlay' }, '');
    return () => {
      const i = open.indexOf(entry);
      if (i < 0) return; // closed by Back: its entry is already gone
      open.splice(i, 1);
      skip++;
      history.back();
    };
  }, [shown]);
}
