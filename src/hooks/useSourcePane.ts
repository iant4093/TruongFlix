import { useEffect, useState, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { reveal } from '../lib/scroll';

type Rect = { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number };

/** Keeps the isolated native source view inside its visible slot, clear of trusted controls. */
export default function useSourcePane(slot: RefObject<HTMLElement>, requestId: string | null, scrollIntoView = false) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError('');
    const element = slot.current;
    if (!element || !requestId) return;
    const scroll = element.closest<HTMLElement>('[data-catalog-scroll]');
    let stopped = false, inFlight = false, frame = 0;
    let pending: Rect | null | undefined;
    let previous = '';
    const flush = async () => {
      if (inFlight) return;
      inFlight = true;
      while (!stopped && pending !== undefined) {
        const rect = pending; pending = undefined;
        try { await invoke('source_browser_place', { requestId, rect }); if (!stopped) setError(''); }
        catch { if (!stopped) setError('The source view could not be displayed. Try again or close it.'); }
      }
      inFlight = false;
    };
    const measure = () => {
      frame = 0;
      if (stopped) return;
      const box = element.getBoundingClientRect();
      const container = scroll?.getBoundingClientRect();
      const x = Math.max(0, box.left, container?.left ?? 0);
      const y = Math.max(64, box.top, (container?.top ?? 0) + 64);
      const right = Math.min(window.innerWidth, box.right, container?.right ?? window.innerWidth);
      const bottom = Math.min(window.innerHeight - 8, box.bottom, container?.bottom ?? window.innerHeight);
      const rect: Rect | null = document.hidden || right - x < 80 || bottom - y < 80 ? null
        : { x, y, width: right - x, height: bottom - y, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
      const key = JSON.stringify(rect);
      if (key === previous) return;
      previous = key; pending = rect; void flush();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    if (scroll) observer.observe(scroll);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', measure);
    if (scrollIntoView) reveal(element, 'center');
    measure();
    return () => {
      stopped = true; pending = undefined; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', measure);
      void invoke('source_browser_place', { requestId, rect: null }).catch(() => {});
    };
  }, [requestId, attempt, scrollIntoView, slot]);
  return { error, retry: () => setAttempt((value) => value + 1) };
}
