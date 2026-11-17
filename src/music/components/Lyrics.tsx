import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { activeIndex, lyricTimeline, parseLrc, progressOf, type LyricEntry } from '../lrc';
import { musicClock, useMusicPlayer } from '../player';
import type { MusicLyrics } from '../types';

const cache = new Map<number, MusicLyrics>();

/** Lyrics for a song, fetched once per session (a miss is asked again next time). `retry` searches online again. */
export function useLyrics(trackId: number | null) {
  const api = useMusicPlayer((s) => s.api);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ id: number | null; lyrics: MusicLyrics | null; loading: boolean }>({ id: null, lyrics: null, loading: false });
  useEffect(() => {
    if (trackId == null || !api) return setState({ id: null, lyrics: null, loading: false });
    const hit = cache.get(trackId);
    if (!attempt && hit) return setState({ id: trackId, lyrics: hit, loading: false });
    let live = true;
    setState({ id: trackId, lyrics: null, loading: true });
    api
      .lyrics(trackId, attempt > 0)
      .then((l) => {
        if (l) cache.set(trackId, l);
        if (live) setState({ id: trackId, lyrics: l, loading: false });
      })
      .catch(() => live && setState({ id: trackId, lyrics: null, loading: false }));
    return () => {
      live = false;
    };
  }, [trackId, api, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...(state.id === trackId ? state : { id: trackId, lyrics: null, loading: true }), retry };
}

/** Where the current line sits in the view (fraction of its height from the top). */
const ANCHOR = 0.3;
const MANUAL_IDLE_MS = 2600;

/** Safari (and every iPhone/iPad browser) draws blurred, moving text with stray edges, so lines aren't blurred there. */
const BLUR_OK = typeof navigator !== 'undefined' && !(/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent));

/** Apple Music's lyric scroll: a soft ease-out, each line below starting a beat later. */
const EASE = 'cubic-bezier(0.22, 0.9, 0.28, 1)';
const MOVE_S = 0.8;

interface Props {
  trackId: number;
  duration: number;
  onSeek: (t: number) => void;
  /** Phone layout: smaller type. */
  compact?: boolean;
  className?: string;
}

export default function Lyrics({ trackId, duration, onSeek, compact = false, className = '' }: Props) {
  const { lyrics, loading, retry } = useLyrics(trackId);
  const parsed = useMemo(() => (lyrics ? parseLrc(lyrics.text, duration) : null), [lyrics, duration]);
  const entries = useMemo(() => (parsed ? lyricTimeline(parsed) : []), [parsed]);

  if (loading) return <div className={`flex items-center justify-center text-white/50 ${className}`}>Loading lyrics…</div>;
  if (!parsed || !entries.length || lyrics?.instrumental)
    return (
      <div className={`flex flex-col items-center justify-center gap-4 px-8 text-center text-lg font-semibold text-white/60 ${className}`}>
        {lyrics?.instrumental ? 'This song is instrumental.' : 'Lyrics aren’t available for this song.'}
        {!lyrics?.instrumental && (
          <button type="button" onClick={retry} className="rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold text-white/85 hover:bg-white/20">
            Search again
          </button>
        )}
      </div>
    );
  if (!parsed.synced) return <PlainLyrics lines={entries} compact={compact} className={className} source={lyrics?.source} />;
  return <SyncedLyrics key={trackId} entries={entries} onSeek={onSeek} compact={compact} className={className} source={lyrics?.source} />;
}

function Credit({ source }: { source?: string }) {
  if (source !== 'lrclib' && source !== 'netease') return null;
  return <p className="mt-10 text-xs font-medium text-white/40">Lyrics from {source === 'netease' ? 'NetEase Cloud Music' : 'LRCLIB'}</p>;
}

function PlainLyrics({ lines, compact, className, source }: { lines: LyricEntry[]; compact: boolean; className: string; source?: string }) {
  return (
    <div className={`tfm-scroll overflow-y-auto overscroll-contain px-6 py-10 ${className}`}>
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
  const drag = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const wordRefs = useRef<Map<number, (HTMLSpanElement | null)[]>>(new Map());
  const dotRefs = useRef<Map<number, (HTMLSpanElement | null)[]>>(new Map());
  const [idx, setIdx] = useState(() => activeIndex(entries, musicClock()));
  const [target, setTarget] = useState(0);
  const targetRef = useRef(0);
  targetRef.current = target;
  const [manual, setManual] = useState(false);
  const offset = useRef(0);
  const idleTimer = useRef<number | null>(null);
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const blurOk = BLUR_OK && !compact && !reduce;

  // One set of ref callbacks per row for the life of the song, so rows stay memoised between renders.
  const rowRefs = useMemo(
    () =>
      entries.map((_, i) => ({
        line: (el: HTMLDivElement | null) => {
          lineRefs.current[i] = el;
        },
        word: (k: number, el: HTMLSpanElement | null) => {
          const list = wordRefs.current.get(i) ?? [];
          list[k] = el;
          wordRefs.current.set(i, list);
        },
        dot: (k: number, el: HTMLSpanElement | null) => {
          const list = dotRefs.current.get(i) ?? [];
          list[k] = el;
          dotRefs.current.set(i, list);
        },
      })),
    [entries],
  );

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

  // Wheel / finger scrolling moves one layer directly (no re-render per move) and pauses following.
  const applyOffset = useCallback((animate: boolean) => {
    const el = drag.current;
    if (!el) return;
    el.style.transition = animate ? `transform 0.6s ${EASE}` : 'none';
    el.style.transform = `translate3d(0, ${-offset.current}px, 0)`;
  }, []);
  const release = useCallback(() => {
    offset.current = 0;
    applyOffset(true);
    setManual(false);
  }, [applyOffset]);
  const nudge = useCallback((delta: number) => {
    const box = inner.current;
    const max = box ? box.scrollHeight : 10000;
    const t = targetRef.current;
    offset.current = Math.max(-t - 200, Math.min(max - t, offset.current + delta));
    applyOffset(false);
    setManual(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(release, MANUAL_IDLE_MS);
  }, [applyOffset, release]);
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

  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const seekTo = useCallback((t: number) => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    release();
    onSeekRef.current(t);
  }, [release]);

  const y = -target;
  return (
    <div ref={viewport} className={`relative select-none overflow-hidden ${className}`} style={{ maskImage: 'linear-gradient(transparent 0, #000 9%, #000 82%, transparent 100%)', WebkitMaskImage: 'linear-gradient(transparent 0, #000 9%, #000 82%, transparent 100%)' }}>
      <div ref={drag} style={{ transform: 'translate3d(0, 0, 0)' }}>
        <div ref={inner} className={`relative ${compact ? 'px-6' : 'px-8'} pb-[70vh] pt-[6vh]`}>
          {entries.map((e, i) => (
            <LyricRow
              key={i}
              entry={e}
              distance={i - idx}
              y={y}
              reduce={reduce}
              blurOk={blurOk}
              manual={manual}
              compact={compact}
              onSeek={seekTo}
              lineRef={rowRefs[i].line}
              wordRef={rowRefs[i].word}
              dotRef={rowRefs[i].dot}
            />
          ))}
          <div style={{ transform: `translate3d(0, ${y}px, 0)`, transition: reduce ? 'none' : `transform ${MOVE_S}s ${EASE}` }}>
            <Credit source={source} />
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  entry: LyricEntry;
  distance: number;
  y: number;
  reduce: boolean;
  blurOk: boolean;
  manual: boolean;
  compact: boolean;
  onSeek: (t: number) => void;
  lineRef: (el: HTMLDivElement | null) => void;
  wordRef: (k: number, el: HTMLSpanElement | null) => void;
  dotRef: (k: number, el: HTMLSpanElement | null) => void;
}

/** Rows this far from the current line are out of view: they move without a transition and aren't blurred. */
const NEAR_ABOVE = 8;
const NEAR_BELOW = 16;

/** Lines move with CSS transitions, which run on the compositor: smooth even on phones. */
const LyricRow = memo(function LyricRow({ entry, distance, y, reduce, blurOk, manual, compact, onSeek, lineRef, wordRef, dotRef }: RowProps) {
  const active = distance === 0;
  const past = distance < 0;
  const near = distance >= -NEAR_ABOVE && distance <= NEAR_BELOW;
  // Lines below the current one follow a beat later, which gives the scroll its ripple.
  const delay = reduce || manual ? 0 : Math.max(0, Math.min(distance, 8)) * 0.045;
  const move = reduce ? 'transform 0.15s linear' : near ? `transform ${MOVE_S}s ${EASE} ${delay}s` : 'transform 0s';
  const blur = !blurOk || manual || active || Math.abs(distance) > NEAR_ABOVE ? 0 : Math.min(Math.abs(distance), 4) * 0.6;
  const opacity = manual ? (active ? 1 : 0.55) : active ? 1 : past ? 0.28 : Math.abs(distance) === 1 ? 0.42 : 0.32;
  const scale = active || reduce ? 1 : 0.965;

  if (entry.kind === 'gap') {
    return (
      <div
        ref={lineRef}
        className="origin-left overflow-hidden"
        style={{ transform: `translate3d(0, ${y}px, 0)`, maxHeight: active ? 80 : 0, opacity: active ? 1 : 0, transition: `${move}, max-height 0.45s ease, opacity 0.3s ease` }}
        aria-hidden
      >
        <div className={`py-3 ${compact ? 'text-[1.7rem]' : 'text-[2.4rem]'}`}>
          <span className={`tfm-dots ${active ? 'tfm-dots-active' : ''}`}>
            {[0, 1, 2].map((k) => (
              <span key={k} ref={(el) => dotRef(k, el)} style={{ opacity: 0.3 }} />
            ))}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={lineRef}
      className="origin-left"
      style={{ transform: `translate3d(0, ${y}px, 0) scale(${scale})`, transition: move, willChange: near ? 'transform' : undefined }}
    >
      <button
        type="button"
        onClick={() => onSeek(entry.time)}
        className={`block w-full rounded-xl py-2.5 text-left font-bold leading-[1.18] tracking-tight transition-[opacity,filter] duration-500 [-webkit-tap-highlight-color:transparent] focus-visible:bg-white/10 focus-visible:outline-none [@media(hover:hover)]:hover:bg-white/[0.06] ${compact ? '-mx-1.5 px-1.5 text-[1.65rem]' : '-mx-3 px-3 text-[2.35rem]'}`}
        style={{ opacity, filter: blur ? `blur(${blur}px)` : undefined }}
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
    </div>
  );
});
