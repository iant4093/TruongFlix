import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ShieldCheck } from 'lucide-react';

type Rect = { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number };
export default function SourceVerification({ requestId }: { requestId: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
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
        catch { if (!stopped) setError('Verification could not be displayed. Try again or cancel the search.'); }
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
    document.addEventListener('visibilitychange', schedule);
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    schedule();
    return () => {
      stopped = true; pending = undefined; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      void invoke('source_browser_place', { requestId, rect: null }).catch(() => {});
    };
  }, [requestId, retry]);
  return <section aria-label="Source verification" className="mt-5 overflow-hidden rounded-lg border border-white/15 bg-[#111]">
    <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4"><ShieldCheck className="h-5 w-5 shrink-0 text-nf-red" /><div><h3 className="text-sm font-semibold">Verify to continue</h3><p className="mt-1 text-xs text-white/50">Complete your source’s verification here. The search resumes automatically.</p></div></div>
    {error && <p role="alert" className="px-5 py-3 text-sm text-red-300">{error}<button onClick={() => setRetry((v) => v + 1)} className="ml-3 underline">Retry verification</button></p>}
    <div ref={slot} className="h-[360px] w-full bg-[#181818]" />
  </section>;
}
