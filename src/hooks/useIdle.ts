import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Player chrome visibility: `active` turns false after `ms` without a wake-up. Mouse moves over a
 * web player frame never reach the app, so players cover the frames with an idle shield (which
 * also hides the cursor) and wake on the first move over it.
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
