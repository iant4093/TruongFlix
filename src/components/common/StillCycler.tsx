import { useEffect, useRef, useState, type CSSProperties } from 'react';

/** How long each still shows before the next one fades in. */
export const STILL_INTERVAL_MS = 2400;
const FADE_MS = 800;

/** Resolves once the image is decoded, so it never pops in half-loaded (and broken ones are skipped). */
function preload(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (typeof img.decode === 'function') img.decode().then(() => resolve(true), () => resolve(true));
      else resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

interface Frame {
  src: string;
  /** Counts up with every change: keys the element and alternates the drift direction. */
  n: number;
}

/**
 * Cycles through stills like a preview: each one is decoded first, then fades in on top of the
 * last (which stays fully visible underneath, so there's no dip), drifting slowly as it shows.
 * `stills` may grow while it plays (frames arrive one by one).
 */
export default function StillCycler({ stills, className = '', interval = STILL_INTERVAL_MS }: { stills: string[]; className?: string; interval?: number }) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [retry, setRetry] = useState(0);
  const list = useRef(stills);
  list.current = stills;
  const first = stills[0] ?? null;

  // First still: show it once it's decoded.
  useEffect(() => {
    setFrames([]);
    if (!first) return;
    let live = true;
    void preload(first).then((ok) => live && ok && setFrames([{ src: first, n: 0 }]));
    return () => {
      live = false;
    };
  }, [first]);

  // Then the next one every `interval`, waiting for it to decode.
  const showing = frames[frames.length - 1];
  useEffect(() => {
    if (!showing) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const all = list.current;
      if (all.length < 2) return void (live && setRetry((r) => r + 1)); // more stills may be on the way
      const at = all.indexOf(showing.src);
      const next = all[(at + 1) % all.length];
      void preload(next).then((ok) => {
        if (!live) return;
        if (!ok) return setRetry((r) => r + 1);
        // Keep the one underneath until the new one has fully faded in.
        setFrames((f) => [...f.slice(-1), { src: next, n: showing.n + 1 }]);
      });
    }, interval);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [showing, interval, retry]);

  if (!frames.length) return null;
  const style = { ['--nf-still-life' as string]: `${interval + FADE_MS}ms` } as CSSProperties;
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`} style={style} aria-hidden>
      {frames.map((f) => (
        <img key={f.n} src={f.src} alt="" draggable={false} className={`nf-still ${f.n % 2 ? 'nf-still-b' : ''}`} />
      ))}
    </div>
  );
}
