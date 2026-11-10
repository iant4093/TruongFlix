import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { scrollBehavior } from './scroll';

/**
 * Where you were in each top-level section (Home, TV, Browse, Games…): scroll position, row
 * pages and view choices, kept for the session so switching sections and back lands you in place.
 */
const scroll = new Map<string, number>();
const values = new Map<string, unknown>();
const visited = new Set<string>();

export function forgetSection(section?: string) {
  if (section == null) {
    scroll.clear();
    values.clear();
    visited.clear();
    return;
  }
  scroll.delete(section);
  for (const key of [...values.keys()]) if (key.startsWith(`${section}:`)) values.delete(key);
}

interface Section {
  key: string;
  /** True when coming back to a section already seen this session (skip entrance animations). */
  revisit: boolean;
  mountedAt: number;
}

const SectionContext = createContext<Section | null>(null);

export const useSection = () => useContext(SectionContext);

/**
 * True for content mounting as part of returning to a section: it should appear in place
 * (the section itself fades in) instead of running its own entrance animation as well.
 */
export function useSkipEntrance() {
  const section = useContext(SectionContext);
  const [skip] = useState(() => !!section?.revisit && performance.now() - section.mountedAt < 800);
  return skip;
}

/** `useState` that survives leaving and re-entering the current section. */
export function useSectionState<T>(key: string, initial: T | (() => T)) {
  const section = useContext(SectionContext);
  const id = section ? `${section.key}:${key}` : null;
  const [value, setValue] = useState<T>(() =>
    id && values.has(id) ? (values.get(id) as T) : typeof initial === 'function' ? (initial as () => T)() : initial,
  );
  useEffect(() => {
    if (id) values.set(id, value);
  }, [id, value]);
  return [value, setValue] as const;
}

const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
const RESTORE_LIMIT_MS = 2000;

/**
 * Provides the section to its children, restores its scroll position when it mounts (waiting
 * for content to grow tall enough, until the user takes over) and records it while present.
 */
export function SectionMemory({ section, active = true, children }: { section: string; active?: boolean; children: ReactNode }) {
  const [value] = useState<Section>(() => ({ key: section, revisit: visited.has(section), mountedAt: performance.now() }));

  useLayoutEffect(() => {
    if (!active) return;
    visited.add(section);
    const target = scroll.get(section) ?? 0;
    // Place the new section before its fade starts. If it grows after mounting, move only
    // when more of the remembered position is reachable. Reaching the bottom can load another page.
    window.scrollTo({ top: target, behavior: 'instant' });
    let frame = 0;
    const initialPosition = window.scrollY;
    let destination = initialPosition;
    let waiting = Math.abs(initialPosition - target) >= 2;
    const started = performance.now();
    const stop = () => {
      waiting = false;
      cancelAnimationFrame(frame);
      for (const type of USER_INPUT) window.removeEventListener(type, cancel, true);
    };
    const cancel = () => {
      if (waiting && destination !== initialPosition && Math.abs(window.scrollY - destination) >= 2) {
        window.scrollTo({ top: window.scrollY, behavior: 'instant' });
      }
      stop();
    };
    const attempt = () => {
      if (!waiting) return;
      const page = document.scrollingElement ?? document.documentElement;
      const available = Math.max(0, page.scrollHeight - window.innerHeight);
      const next = Math.min(target, available);
      if (next > destination + 1) {
        destination = next;
        window.scrollTo({ top: destination, behavior: scrollBehavior() });
      }
      if (Math.abs(window.scrollY - target) < 2 || performance.now() - started > RESTORE_LIMIT_MS) stop();
      else frame = requestAnimationFrame(attempt);
    };
    if (waiting) {
      for (const type of USER_INPUT) window.addEventListener(type, cancel, { capture: true, passive: true });
      frame = requestAnimationFrame(attempt);
    }

    const record = () => {
      if (!waiting) scroll.set(section, window.scrollY);
    };
    window.addEventListener('scroll', record, { passive: true });
    return () => {
      cancel();
      window.removeEventListener('scroll', record);
    };
  }, [section, active]);

  return <SectionContext.Provider value={value}>{children}</SectionContext.Provider>;
}
