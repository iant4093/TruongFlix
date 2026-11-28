import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { activeIndex, lyricTimeline, parseLrc, progressOf, type LyricEntry } from '../lrc';
import { FOLLOW_SPRING, FollowControl, handover, lineLook, NEAR_ABOVE, NEAR_BELOW, SETTLE_SPRING, staggerMs, stepSpring } from '../lyricsMotion';
import { musicClock, useMusicPlayer } from '../player';
import type { MusicLyrics } from '../types';

/**
 * Lyrics fetched this session. They're asked for again after a while: a phone can keep the browser
 * app open for days, and the PC may have found better lyrics since (a new lookup, a new service).
 */
const cache = new Map<number, { lyrics: MusicLyrics; at: number }>();
const CACHE_MS = 15 * 60_000;
const cached = (trackId: number) => {
  const hit = cache.get(trackId);
  return hit && Date.now() - hit.at < CACHE_MS ? hit.lyrics : null;
};
const remember = (trackId: number, lyrics: MusicLyrics | null) => {
  if (lyrics) cache.set(trackId, { lyrics, at: Date.now() });
};
const pending = new Map<number, Promise<MusicLyrics | null>>();

/**
 * Starts fetching a song's lyrics (once), so they're ready when the lyrics open: an online lookup
 * takes a second or so the first time.
 */
export function prefetchLyrics(trackId: number): Promise<MusicLyrics | null> {
  const hit = cached(trackId);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(trackId);
  if (running) return running;
  const api = useMusicPlayer.getState().api;
  if (!api) return Promise.resolve(null);
  const job = api
    .lyrics(trackId)
    .then((l) => {
      remember(trackId, l);
      return l;
    })
    .catch(() => null)
    .finally(() => pending.delete(trackId));
  pending.set(trackId, job);
  return job;
}

// The current song's lyrics as soon as it starts, and the next song's while this one plays.
let prefetched = '';
useMusicPlayer.subscribe((s) => {
  if (!s.api) return;
  const ids = [s.queue.items[s.queue.index]?.id, s.queue.items[s.queue.index + 1]?.id].filter((id): id is number => id != null);
  const key = ids.join(',');
  if (key === prefetched) return;
  prefetched = key;
  for (const id of ids) void prefetchLyrics(id);
});

/** Lyrics for a song (kept for a while; a miss is asked again next time). `retry` searches online again. */
export function useLyrics(trackId: number | null) {
  const api = useMusicPlayer((s) => s.api);
  // "Search again" applies to the song it was tapped on, not to every song after it.
  const [retried, setRetried] = useState<{ id: number | null; n: number }>({ id: null, n: 0 });
  const attempt = retried.id === trackId ? retried.n : 0;
  const [state, setState] = useState<{ id: number | null; lyrics: MusicLyrics | null; loading: boolean }>({ id: null, lyrics: null, loading: false });
  useEffect(() => {
    if (trackId == null || !api) return setState({ id: null, lyrics: null, loading: false });
    const hit = cached(trackId);
    if (!attempt && hit) return setState({ id: trackId, lyrics: hit, loading: false });
    let live = true;
    setState({ id: trackId, lyrics: null, loading: true });
    const job = attempt > 0 ? api.lyrics(trackId, true) : prefetchLyrics(trackId);
    job
      .then((l) => {
        remember(trackId, l);
        if (live) setState({ id: trackId, lyrics: l, loading: false });
      })
      .catch(() => live && setState({ id: trackId, lyrics: null, loading: false }));
    return () => {
      live = false;
    };
  }, [trackId, api, attempt]);
  const retry = useCallback(() => setRetried((r) => ({ id: trackId, n: r.id === trackId ? r.n + 1 : 1 })), [trackId]);
  return { ...(state.id === trackId ? state : { id: trackId, lyrics: null, loading: true }), retry };
}

/** Where the current line sits in the view (fraction of its height from the top). */
const ANCHOR = 0.3;

/** Safari (and every iPhone/iPad browser) draws blurred, moving text with stray edges, so lines aren't blurred there. */
const BLUR_OK = typeof navigator !== 'undefined' && !(/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent));

/** Lines melt into the edges (an eased fade, longer at the bottom) instead of being cut off. */
const MASK =
  'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.12) 2%, rgba(0,0,0,0.45) 5.5%, rgba(0,0,0,0.82) 9.5%, #000 13%, #000 72%, rgba(0,0,0,0.82) 80%, rgba(0,0,0,0.45) 88%, rgba(0,0,0,0.12) 95%, transparent 100%)';

/** The ease of a line's fade, blur and size change, close to the glide's spring. */
const EASE = 'cubic-bezier(0.22, 0.9, 0.28, 1)';

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
  const name = { lrclib: 'LRCLIB', netease: 'NetEase Cloud Music', kugou: 'Kugou Music' }[source ?? ''];
  if (!name) return null;
  return <p className="mt-10 text-xs font-medium text-white/40">Lyrics from {name}</p>;
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
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  const viewport = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // One element per row; the credit under the last line is the extra row at the end.
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const wordRefs = useRef<Map<number, (HTMLSpanElement | null)[]>>(new Map());
  const dotRefs = useRef<Map<number, (HTMLSpanElement | null)[]>>(new Map());
  const [idx, setIdx] = useState(() => activeIndex(entries, musicClock()));
  // Drawn as scrolled by hand (every line readable). Set by a real scroll, not by a finger landing,
  // so tapping a line to jump to it doesn't make the lines flicker.
  const [browsing, setBrowsing] = useState(false);
  // Which way the lyrics last moved: the lines trailing the move change a beat later too.
  const [up, setUp] = useState(true);
  const blurOk = BLUR_OK && !compact && !reduce;

  // The motion lives outside React: a spring per row, written to the row's transform every frame.
  // While following, the list's own scroll position stays put (`base`) and the rows glide by
  // transforms on top of it. A hand scroll hands over to the browser's scrolling (momentum,
  // rubber-banding), which is what a phone's lists feel like, without anything moving.
  const m = useMemo(() => {
    const n = entries.length + 1;
    return {
      follow: new FollowControl(),
      base: 0,
      springs: Array.from({ length: n }, () => ({ y: 0, v: 0 })),
      drawn: new Array<number>(n).fill(NaN),
      /** A row's goal while it waits for its turn to set off. */
      held: new Array<number>(n).fill(0),
      releaseAt: new Array<number>(n).fill(0),
      idx: activeIndex(entries, musicClock()),
      /** Last frame's goal while following, to tell which way the next move goes. */
      lastGoal: 0,
      /** Set off again from wherever the rows are (following again after a hand scroll). */
      restagger: false,
      up: true,
      last: 0,
      fresh: true,
      /** The scroll position we just set ourselves, so its scroll event isn't taken for the user's. */
      ownScroll: NaN,
    };
  }, [entries]);

  const draw = useCallback(
    (r: number) => {
      const el = rowEls.current[r];
      const y = m.springs[r].y;
      if (!el || Math.abs(y - m.drawn[r]) < 0.01) return;
      m.drawn[r] = y;
      el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    },
    [m],
  );

  /** Back to following the song, gliding from wherever the list was scrolled to. */
  const resume = useCallback(() => {
    if (!m.follow.manual) return;
    m.follow.resume();
    m.base = viewport.current?.scrollTop ?? 0;
    m.held.fill(0);
    m.lastGoal = 0;
    m.restagger = true;
    setBrowsing(false);
  }, [m]);

  /** The user takes over: scroll the list to where the rows are drawn, so nothing moves. */
  const takeOver = useCallback(() => {
    const view = viewport.current;
    if (!view) return;
    const { scrollTop, shift } = handover(
      m.springs.map((s) => s.y),
      Math.max(0, m.idx),
      view.scrollTop,
      view.scrollHeight - view.clientHeight,
    );
    for (let r = 0; r < m.springs.length; r++) {
      m.springs[r].y += shift;
      draw(r);
    }
    if (Math.abs(view.scrollTop - scrollTop) >= 0.5) {
      m.ownScroll = scrollTop;
      view.scrollTop = scrollTop;
    }
    m.base = scrollTop;
  }, [m, draw]);

  // One set of ref callbacks per row for the life of the song, so rows stay memoised between renders.
  const rowRefs = useMemo(
    () =>
      Array.from({ length: entries.length + 1 }, (_, i) => ({
        line: (el: HTMLDivElement | null) => {
          rowEls.current[i] = el;
          m.drawn[i] = NaN;
          if (el) {
            const y = m.springs[i].y;
            el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
            m.drawn[i] = y;
          }
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
    [entries, m],
  );

  // Room above the first line and below the last, so either can sit at the anchor: the list never
  // has to stop short, and the first lines don't sit under the faded top edge.
  useLayoutEffect(() => {
    const view = viewport.current;
    const box = inner.current;
    if (!view || !box) return;
    const fit = () => {
      const h = view.clientHeight;
      if (!h) return;
      box.style.paddingTop = `${Math.round(h * ANCHOR)}px`;
      box.style.paddingBottom = `${Math.round(h * (1 - ANCHOR))}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(view);
    return () => ro.disconnect();
  }, []);

  // Per frame: which line is current, how far through each word / break we are, and every row's glide.
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const t = musicClock();
      const i = activeIndex(entries, t);
      if (m.follow.shouldResume(now)) resume();
      const view = viewport.current;
      const following = !m.follow.manual;
      // Measured every frame, so a break opening or closing, a line wrapping differently after a
      // resize or the panel changing size only moves the goal, and the springs follow it smoothly.
      let goal = 0;
      if (following && view) {
        const el = rowEls.current[Math.max(0, i)];
        if (el) goal = m.base - (el.offsetTop - view.clientHeight * ANCHOR);
      }
      if (i !== m.idx || m.restagger) {
        // A new line (or following again): each row sets off for it, the trailing ones a beat later.
        if (following) {
          const up = goal <= m.lastGoal;
          for (let r = 0; r < m.springs.length; r++) m.releaseAt[r] = now + staggerMs(r - Math.max(0, i), reduceRef.current, up);
          if (up !== m.up) setUp((m.up = up));
        }
        m.restagger = false;
        if (i !== m.idx) setIdx((m.idx = i));
      }
      if (following) m.lastGoal = goal;
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

      if (!view) return;
      const dt = m.last ? Math.min(0.1, (now - m.last) / 1000) : 0;
      m.last = now;
      const snap = m.fresh || reduceRef.current;
      for (let r = 0; r < m.springs.length; r++) {
        let g = goal;
        if (following) {
          if (now < m.releaseAt[r]) g = m.held[r];
          else m.held[r] = goal;
        }
        const s = m.springs[r];
        if (snap) {
          s.y = g;
          s.v = 0;
        } else stepSpring(s, g, dt, following ? FOLLOW_SPRING : SETTLE_SPRING);
        draw(r);
      }
      m.fresh = false;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [entries, m, draw, resume]);

  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const grab = () => {
      if (m.follow.input(performance.now())) takeOver();
      setBrowsing(true);
    };
    const touch = (e: TouchEvent) => {
      if (m.follow.touch(performance.now(), e.touches.length)) takeOver();
    };
    const key = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) grab();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      let keyboard = false;
      try {
        keyboard = !!el?.matches(':focus-visible');
      } catch {
        /* engines without :focus-visible */
      }
      if (!keyboard || !el) return;
      grab();
      el.scrollIntoView({ block: 'nearest' });
    };
    const scrolled = () => {
      const own = Math.abs(view.scrollTop - m.ownScroll) < 0.5;
      m.ownScroll = NaN;
      if (own) return;
      if (m.follow.manual) {
        m.follow.input(performance.now());
        setBrowsing(true);
        return;
      }
      // Following, and the browser moved the list itself (it got shorter): keep every line where it is.
      const d = view.scrollTop - m.base;
      if (Math.abs(d) < 0.5) return;
      m.base = view.scrollTop;
      for (let r = 0; r < m.springs.length; r++) {
        m.springs[r].y += d;
        m.held[r] += d;
        draw(r);
      }
    };
    view.addEventListener('wheel', grab, { passive: true });
    view.addEventListener('touchstart', touch, { passive: true });
    view.addEventListener('touchend', touch, { passive: true });
    view.addEventListener('touchcancel', touch, { passive: true });
    view.addEventListener('keydown', key);
    view.addEventListener('focusin', focus);
    view.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      view.removeEventListener('wheel', grab);
      view.removeEventListener('touchstart', touch);
      view.removeEventListener('touchend', touch);
      view.removeEventListener('touchcancel', touch);
      view.removeEventListener('keydown', key);
      view.removeEventListener('focusin', focus);
      view.removeEventListener('scroll', scrolled);
    };
  }, [m, takeOver, draw]);

  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const seekTo = useCallback(
    (t: number) => {
      resume();
      onSeekRef.current(t);
    },
    [resume],
  );

  return (
    <div className={`relative ${className}`}>
      <div
        ref={viewport}
        className="tfm-scroll h-full select-none overflow-y-auto overscroll-contain [overflow-anchor:none]"
        style={{ maskImage: MASK, WebkitMaskImage: MASK }}
      >
        <div ref={inner} className={`relative ${compact ? 'px-6' : 'px-8'} pb-[70vh] pt-[25vh]`}>
          {entries.map((e, i) => (
            <LyricRow
              key={i}
              entry={e}
              distance={i - idx}
              reduce={reduce}
              blurOk={blurOk}
              browsing={browsing}
              up={up}
              compact={compact}
              onSeek={seekTo}
              lineRef={rowRefs[i].line}
              wordRef={rowRefs[i].word}
              dotRef={rowRefs[i].dot}
            />
          ))}
          <div ref={rowRefs[entries.length].line}>
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
  reduce: boolean;
  blurOk: boolean;
  browsing: boolean;
  up: boolean;
  compact: boolean;
  onSeek: (t: number) => void;
  lineRef: (el: HTMLDivElement | null) => void;
  wordRef: (k: number, el: HTMLSpanElement | null) => void;
  dotRef: (k: number, el: HTMLSpanElement | null) => void;
}

/**
 * A line. Its glide (the row's transform) is written per frame by SyncedLyrics; React only sets how
 * it looks, and the fade, blur and size change set off together with the glide.
 */
const LyricRow = memo(function LyricRow({ entry, distance, reduce, blurOk, browsing, up, compact, onSeek, lineRef, wordRef, dotRef }: RowProps) {
  const active = distance === 0;
  const near = distance >= -NEAR_ABOVE && distance <= NEAR_BELOW;
  const look = lineLook(distance, { manual: browsing, blur: blurOk, reduce });
  const delay = browsing ? 0 : staggerMs(distance, reduce, up);
  const change = reduce
    ? 'opacity 0.2s linear'
    : `opacity 0.6s ${EASE} ${delay}ms, filter 0.6s ${EASE} ${delay}ms, transform 0.75s ${EASE} ${delay}ms`;

  if (entry.kind === 'gap') {
    return (
      <div
        ref={lineRef}
        className="overflow-hidden"
        style={{
          maxHeight: active ? 80 : 0,
          opacity: active ? 1 : 0,
          transition: reduce ? 'opacity 0.2s linear' : `max-height 0.55s ${EASE}, opacity 0.35s ease`,
          willChange: near ? 'transform' : undefined,
        }}
        aria-hidden
      >
        <div className={`py-3 leading-none ${compact ? 'text-[1.7rem]' : 'text-[2.4rem]'}`}>
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
    <div ref={lineRef} style={{ willChange: near ? 'transform' : undefined }}>
      <button
        type="button"
        onClick={() => onSeek(entry.time)}
        className={`block w-full origin-left rounded-xl py-2.5 text-left font-bold leading-[1.18] tracking-tight [-webkit-tap-highlight-color:transparent] focus-visible:bg-white/10 focus-visible:outline-none [@media(hover:hover)]:hover:bg-white/[0.06] ${compact ? '-mx-1.5 px-1.5 text-[1.65rem]' : '-mx-3 px-3 text-[2.35rem]'}`}
        style={{ opacity: look.opacity, filter: look.blur ? `blur(${look.blur}px)` : 'none', transform: `scale(${look.scale})`, transition: change }}
      >
        {/* Split into words or not, the text is laid out the same, so a long line wraps at the same
            places when it becomes the current one. */}
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
