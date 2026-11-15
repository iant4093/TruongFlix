import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { activeIndex, lyricTimeline, parseLrc, progressOf, type LyricEntry } from '../lrc';
import { musicClock, useMusicPlayer } from '../player';
import type { MusicLyrics } from '../types';

const cache = new Map<number, MusicLyrics | null>();

/** Lyrics for a song, fetched once per session. */
export function useLyrics(trackId: number | null) {
  const api = useMusicPlayer((s) => s.api);
  const [state, setState] = useState<{ id: number | null; lyrics: MusicLyrics | null; loading: boolean }>({ id: null, lyrics: null, loading: false });
  useEffect(() => {
    if (trackId == null || !api) return setState({ id: null, lyrics: null, loading: false });
    if (cache.has(trackId)) return setState({ id: trackId, lyrics: cache.get(trackId) ?? null, loading: false });
    let live = true;
    setState({ id: trackId, lyrics: null, loading: true });
    api
      .lyrics(trackId)
      .then((l) => {
        cache.set(trackId, l);
        if (live) setState({ id: trackId, lyrics: l, loading: false });
      })
      .catch(() => live && setState({ id: trackId, lyrics: null, loading: false }));
    return () => {
      live = false;
    };
  }, [trackId, api]);
  return state.id === trackId ? state : { id: trackId, lyrics: null, loading: true };
}

/** Where the current line sits in the view (fraction of its height from the top). */
const ANCHOR = 0.3;
const MANUAL_IDLE_MS = 2600;

interface Props {
  trackId: number;
  duration: number;
  onSeek: (t: number) => void;
  /** Phone layout: smaller type. */
  compact?: boolean;
  className?: string;
}

export default function Lyrics({ trackId, duration, onSeek, compact = false, className = '' }: Props) {
  const { lyrics, loading } = useLyrics(trackId);
  const parsed = useMemo(() => (lyrics ? parseLrc(lyrics.text, duration) : null), [lyrics, duration]);
  const entries = useMemo(() => (parsed ? lyricTimeline(parsed) : []), [parsed]);

  if (loading) return <div className={`flex items-center justify-center text-white/50 ${className}`}>Loading lyrics…</div>;
  if (!parsed || !entries.length || lyrics?.instrumental)
    return (
      <div className={`flex items-center justify-center px-8 text-center text-lg font-semibold text-white/60 ${className}`}>
        {lyrics?.instrumental ? 'This song is instrumental.' : 'Lyrics aren’t available for this song.'}
      </div>
    );
  if (!parsed.synced) return <PlainLyrics lines={entries} compact={compact} className={className} source={lyrics?.source} />;
  return <SyncedLyrics key={trackId} entries={entries} onSeek={onSeek} compact={compact} className={className} source={lyrics?.source} />;
}

function Credit({ source }: { source?: string }) {
  if (source !== 'lrclib') return null;
  return <p className="mt-10 text-xs font-medium text-white/40">Lyrics from LRCLIB</p>;
}

function PlainLyrics({ lines, compact, className, source }: { lines: LyricEntry[]; compact: boolean; className: string; source?: string }) {
  return (
    <div className={`tfm-scroll overflow-y-auto px-6 py-10 ${className}`}>
      <p className="mb-6 text-xs font-semibold uppercase tracking-widest text-white/40">Lyrics aren’t synced to this song</p>
      {lines.map((l, i) =>
        l.kind === 'line' && l.text ? (
          <p key={i} className={`font-bold leading-snug text-white/85 ${compact ? 'text-xl' : 'text-2xl'} mb-2`}>
            {l.text}
          </p>
        ) : (
          <div key={i} className="h-6" />
        ),
      )}
      <Credit source={source} />
    </div>
  );
}

function SyncedLyrics({ entries, onSeek, compact, className, source }: { entries: LyricEntry[]; onSeek: (t: number) => void; compact: boolean; className: string; source?: string }) {
  const reduce = useReducedMotion() ?? false;
  const viewport = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const wordRefs = useRef<Map<number, (HTMLSpanElement | null)[]>>(new Map());
  const dotRefs = useRef<Map<number, (HTMLSpanElement | null)[]>>(new Map());
  const [idx, setIdx] = useState(() => activeIndex(entries, musicClock()));
  const [target, setTarget] = useState(0);
  const [manual, setManual] = useState(0);
  const manualRef = useRef(0);
  const [manualActive, setManualActive] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const idxRef = useRef(idx);
  idxRef.current = idx;

  // Per frame: which line is current, and how far through each word / break we are.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = musicClock();
      const i = activeIndex(entries, t);
      if (i !== idxRef.current) {
        idxRef.current = i;
        setIdx(i);
      }
      const e = entries[i];
      if (e?.kind === 'line' && e.words) {
        const spans = wordRefs.current.get(i);
        e.words.forEach((w, k) => {
          const span = spans?.[k];
          if (!span) return;
          const p = progressOf(w, t);
          span.style.setProperty('--p', p.toFixed(3));
          span.classList.toggle('tfm-lift', p > 0);
        });
      } else if (e?.kind === 'gap') {
        const dots = dotRefs.current.get(i);
        const p = progressOf(e, t);
        const ending = e.end - t < 0.45;
        dots?.forEach((d, k) => {
          if (!d) return;
          const fill = Math.min(1, Math.max(0, p * 3 - k));
          d.style.opacity = String(ending ? 0 : 0.3 + 0.7 * fill);
          d.style.transform = `scale(${ending ? 0.4 : 0.85 + 0.15 * fill})`;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [entries]);

  // Keep the current line about a third of the way down; recompute when breaks open or close.
  const measure = useCallback(() => {
    const view = viewport.current;
    const el = lineRefs.current[Math.max(0, idxRef.current)];
    if (!view || !el) return;
    setTarget(Math.max(0, el.offsetTop - view.clientHeight * ANCHOR));
  }, []);
  useLayoutEffect(measure, [idx, measure]);
  useEffect(() => {
    const view = viewport.current;
    const box = inner.current;
    if (!view || !box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(box);
    ro.observe(view);
    return () => ro.disconnect();
  }, [measure]);

  // Wheel / touch scrolling pauses following for a moment.
  const nudge = useCallback((delta: number) => {
    const box = inner.current;
    const max = box ? box.scrollHeight : 10000;
    manualRef.current = Math.max(-target - 200, Math.min(max - target, manualRef.current + delta));
    setManual(manualRef.current);
    setManualActive(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      manualRef.current = 0;
      setManual(0);
      setManualActive(false);
    }, MANUAL_IDLE_MS);
  }, [target]);
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    let lastY: number | null = null;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      nudge(e.deltaY);
    };
    const start = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? null;
    };
    const moveT = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (lastY == null || y == null) return;
      e.preventDefault();
      nudge(lastY - y);
      lastY = y;
    };
    const end = () => {
      lastY = null;
    };
    view.addEventListener('wheel', wheel, { passive: false });
    view.addEventListener('touchstart', start, { passive: true });
    view.addEventListener('touchmove', moveT, { passive: false });
    view.addEventListener('touchend', end);
    return () => {
      view.removeEventListener('wheel', wheel);
      view.removeEventListener('touchstart', start);
      view.removeEventListener('touchmove', moveT);
      view.removeEventListener('touchend', end);
    };
  }, [nudge]);
  useEffect(() => () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
  }, []);

  const seekTo = (t: number) => {
    manualRef.current = 0;
    setManual(0);
    setManualActive(false);
    onSeek(t);
  };

  const y = -(target + manual);
  return (
    <div ref={viewport} className={`relative select-none overflow-hidden ${className}`} style={{ maskImage: 'linear-gradient(transparent 0, #000 9%, #000 82%, transparent 100%)', WebkitMaskImage: 'linear-gradient(transparent 0, #000 9%, #000 82%, transparent 100%)' }}>
      <div ref={inner} className={`relative ${compact ? 'px-6' : 'px-8'} pb-[70vh] pt-[6vh]`}>
        {entries.map((e, i) => (
          <LyricRow
            key={i}
            index={i}
            entry={e}
            distance={i - idx}
            y={y}
            reduce={reduce}
            manual={manualActive || manual !== 0}
            compact={compact}
            onSeek={seekTo}
            lineRef={(el) => (lineRefs.current[i] = el)}
            wordRef={(k, el) => {
              const list = wordRefs.current.get(i) ?? [];
              list[k] = el;
              wordRefs.current.set(i, list);
            }}
            dotRef={(k, el) => {
              const list = dotRefs.current.get(i) ?? [];
              list[k] = el;
              dotRefs.current.set(i, list);
            }}
          />
        ))}
        <motion.div animate={{ y }} transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 90, damping: 20, mass: 1 }}>
          <Credit source={source} />
        </motion.div>
      </div>
    </div>
  );
}

interface RowProps {
  index: number;
  entry: LyricEntry;
  distance: number;
  y: number;
  reduce: boolean;
  manual: boolean;
  compact: boolean;
  onSeek: (t: number) => void;
  lineRef: (el: HTMLDivElement | null) => void;
  wordRef: (k: number, el: HTMLSpanElement | null) => void;
  dotRef: (k: number, el: HTMLSpanElement | null) => void;
}

const LyricRow = memo(function LyricRow({ entry, distance, y, reduce, manual, compact, onSeek, lineRef, wordRef, dotRef }: RowProps) {
  const active = distance === 0;
  const past = distance < 0;
  // Lines below the current one follow a beat later, which gives the scroll its ripple.
  const delay = reduce || manual ? 0 : Math.max(0, Math.min(distance, 8)) * 0.045;
  const transition = reduce ? { duration: 0.15 } : { type: 'spring' as const, stiffness: 90, damping: 20, mass: 1, delay };
  const blur = reduce || manual || active ? 0 : Math.min(Math.abs(distance), 4) * 0.6;
  const opacity = manual ? (active ? 1 : 0.55) : active ? 1 : past ? 0.28 : Math.abs(distance) === 1 ? 0.42 : 0.32;

  if (entry.kind === 'gap') {
    return (
      <motion.div ref={lineRef} animate={{ y }} transition={transition} className="origin-left overflow-hidden" style={{ maxHeight: active ? 80 : 0, opacity: active ? 1 : 0, transition: 'max-height 0.45s ease, opacity 0.3s ease' }} aria-hidden>
        <div className={`py-3 ${compact ? 'text-[1.7rem]' : 'text-[2.4rem]'}`}>
          <span className={`tfm-dots ${active ? 'tfm-dots-active' : ''}`}>
            {[0, 1, 2].map((k) => (
              <span key={k} ref={(el) => dotRef(k, el)} style={{ opacity: 0.3 }} />
            ))}
          </span>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      ref={lineRef}
      animate={{ y, scale: active || reduce ? 1 : 0.965 }}
      transition={transition}
      className="origin-left"
    >
      <button
        type="button"
        onClick={() => onSeek(entry.time)}
        className={`block w-full rounded-xl py-2.5 text-left font-bold leading-[1.18] tracking-tight transition-[opacity,filter] duration-500 hover:bg-white/[0.06] focus-visible:bg-white/10 focus-visible:outline-none ${compact ? 'text-[1.65rem] px-1.5 -mx-1.5' : 'text-[2.35rem] px-3 -mx-3'}`}
        style={{ opacity, filter: blur ? `blur(${blur}px)` : 'none' }}
      >
        {entry.words && active ? (
          entry.words.map((w, k) => (
            <span key={k} ref={(el) => wordRef(k, el)} className="tfm-word" style={{ ['--p' as string]: 0 }}>
              {w.text}
            </span>
          ))
        ) : (
          <span className="text-white">{entry.text}</span>
        )}
      </button>
    </motion.div>
  );
});
