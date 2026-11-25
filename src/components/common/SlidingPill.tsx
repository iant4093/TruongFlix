import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * The highlight behind (or under) the selected tab of a row, sliding sideways to the next tab.
 *
 * It's measured inside its own row (`offsetLeft`), not on the screen, so it only ever moves along
 * the row: a shared-layout animation measured on screen slid in from above or below whenever
 * switching tabs also scrolled the page. The row must be `position: relative`; the selected tab is
 * the one with `aria-current="page"`.
 */
export default function SlidingPill({ row, watch, className = '', line = false }: { row: RefObject<HTMLElement | null>; watch: unknown; className?: string; line?: boolean }) {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    const start = () => {
      const tabs = row.current;
      const el = tabs?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!tabs || !el) {
        setBox(null);
        placed.current = false;
        return;
      }
      const measure = () =>
        setBox((old) => {
          const next = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
          return old && old.x === next.x && old.y === next.y && old.w === next.w && old.h === next.h ? old : next;
        });
      measure();
      // Again once the section has settled: a row measured mid-entrance can still shift.
      const frame = requestAnimationFrame(measure);
      const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
      ro?.observe(el);
      ro?.observe(tabs);
      stop = () => {
        cancelAnimationFrame(frame);
        ro?.disconnect();
      };
    };
    // React attaches the row's ref only after this (child) effect runs, so on the first mount the
    // row isn't there yet: measure right after the commit instead, still before the first paint.
    // Measuring only here left a row that had just mounted with no highlight at all.
    if (row.current) start();
    else
      queueMicrotask(() => {
        if (!cancelled) start();
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [row, watch]);
  const animate = placed.current;
  placed.current = !!box;
  if (!box) return null;
  const ease = 'cubic-bezier(0.22, 0.9, 0.28, 1)';
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute left-0 top-0 ${className}`}
      style={{
        transform: `translate3d(${box.x}px, ${line ? box.y + box.h + 4 : box.y}px, 0)`,
        width: box.w,
        height: line ? 2 : box.h,
        transition: animate ? `transform 0.38s ${ease}, width 0.38s ${ease}` : 'none',
      }}
    />
  );
}
