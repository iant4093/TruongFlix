import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  ArrowLeft,
  Check,
  Gauge,
  ListVideo,
  Loader2,
  Maximize,
  MessageSquareText,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Sparkles,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { RemotePlayable, RemoteProfile, RemoteStream, RemoteSubStyle } from './types';
import { api, fmtTime } from './api';

type Who = { id: number; key?: string; profile: RemoteProfile };
type Panel = 'tracks' | 'speed' | 'chapters' | null;

const REPORT_MS = 10_000;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SUB_SIZES: { id: RemoteSubStyle['size']; label: string }[] = [
  { id: 'small', label: 'S' },
  { id: 'medium', label: 'M' },
  { id: 'large', label: 'L' },
  { id: 'xlarge', label: 'XL' },
];
const SUB_BACKGROUNDS: { id: RemoteSubStyle['background']; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'shadow', label: 'Shadow' },
  { id: 'translucent', label: 'Dim' },
  { id: 'solid', label: 'Solid' },
];

/** Prefer Apple's native CoreMedia HLS on iOS / iPadOS / macOS Safari (full VOD scrub bar, AirPlay, PiP). */
const PREFER_NATIVE_HLS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
    (/Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(navigator.userAgent)));

function stingerText(stinger: RemoteStream['stinger']): string | null {
  if (stinger === 'both') return 'Stay — scenes during and after the credits';
  if (stinger === 'after') return 'Stay — there’s a scene after the credits';
  if (stinger === 'during') return 'Stay — there’s a scene during the credits';
  return null;
}

/** Full-screen Netflix-style player for the browser app (phones, tablets and computers). */
export default function RemotePlayer({
  who,
  target,
  onExit,
  onPlay,
}: {
  who: Who;
  target: RemotePlayable;
  onExit: () => void;
  onPlay: (t: RemotePlayable) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const streamToken = useRef<string | null>(null);
  const pendingSeek = useRef<number | null>(null);

  const [stream, setStream] = useState<RemoteStream | null>(null);
  const [offset, setOffset] = useState(0);
  const [time, setTime] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [paused, setPaused] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [controls, setControls] = useState(true);
  const [ended, setEnded] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [showRemaining, setShowRemaining] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [dismissedSeg, setDismissedSeg] = useState<string | null>(null);
  const [creditsDismissed, setCreditsDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ripple, setRipple] = useState<'left' | 'right' | null>(null);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  const hideTimer = useRef<number | null>(null);
  const watched = useRef({ last: 0, total: 0 });
  const lastTap = useRef<{ at: number; side: 'left' | 'right' } | null>(null);
  const mounted = useRef(true);
  const loadSeq = useRef(0);
  const choiceRef = useRef<{ aid: number | null; sid: number; subStyle: RemoteSubStyle } | null>(null);

  const base = { profile: who.id, key: who.key };
  const absolute = offset + time;
  const duration = stream?.duration || 0;

  /** Points `<video>` at a stream URL (native HLS on Apple WebKit; hls.js elsewhere). */
  const attach = useCallback((url: string, startAt: number) => {
    const el = video.current;
    if (!el) return;
    hls.current?.destroy();
    hls.current = null;
    setBufferedEnd(0);

    const isHls = url.includes('.m3u8');
    const canNative = el.canPlayType('application/vnd.apple.mpegurl') !== '';
    if (isHls && !(PREFER_NATIVE_HLS && canNative) && Hls.isSupported()) {
      pendingSeek.current = null;
      let recoveredNet = false;
      let recoveredMedia = false;
      const h = new Hls({
        startPosition: startAt > 0.5 ? startAt : 0,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 45_000,
            maxLoadTimeMs: 60_000,
            timeoutRetry: { maxNumRetry: 2, retryDelayMs: 600, maxRetryDelayMs: 2000 },
            errorRetry: { maxNumRetry: 3, retryDelayMs: 600, maxRetryDelayMs: 3000 },
          },
        },
      });
      h.loadSource(url);
      h.attachMedia(el);
      h.on(Hls.Events.MANIFEST_PARSED, () => {
        el.playbackRate = speedRef.current;
        void el.play().catch(() => setPaused(true));
      });
      h.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !recoveredNet) {
          recoveredNet = true;
          h.startLoad();
          return;
        }
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
          recoveredMedia = true;
          h.recoverMediaError();
          return;
        }
        setError('Playback failed. Try again.');
      });
      hls.current = h;
      return;
    }

    pendingSeek.current = startAt > 0.5 ? startAt : null;
    el.src = isHls && startAt > 0.5 ? `${url}#t=${Math.floor(startAt)}` : url;
    el.playbackRate = speedRef.current;
    void el.play().catch(() => setPaused(true));
  }, []);

  const loadStream = useCallback(
    async (opts: { start?: number; aid?: number; sid?: number; subStyle?: Partial<RemoteSubStyle>; prevToken?: string } = {}) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      setError('');
      setEnded(false);
      try {
        const s = await api<RemoteStream>('/play', {
          body: {
            ...base,
            type: target.type,
            id: target.id,
            start: opts.start,
            aid: opts.aid,
            sid: opts.sid,
            subStyle: opts.subStyle,
            prevToken: opts.prevToken,
          },
        });
        if (!mounted.current || seq !== loadSeq.current) {
          void api('/stop', { body: { token: s.token } }).catch(() => {});
          return null;
        }
        streamToken.current = s.token;
        choiceRef.current = { aid: s.aid, sid: s.sid, subStyle: s.subStyle };
        setStream(s);
        setOffset(s.offset);
        setTime(s.start - s.offset);
        attach(s.url, Math.max(0, s.start - s.offset));
        return s;
      } catch (e) {
        if (mounted.current && seq === loadSeq.current) {
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        }
        return null;
      }
    },
    [attach, base.key, base.profile, target.id, target.type],
  );

  // Start playback when target changes.
  useEffect(() => {
    setDismissedSeg(null);
    setCreditsDismissed(false);
    setCountdown(null);
    setPanel(null);
    const prev = streamToken.current ?? undefined;
    streamToken.current = null;
    void loadStream({ start: target.resume >= 0 ? target.resume : undefined, prevToken: prev });
    return () => {
      loadSeq.current++;
    };
  }, [target.type, target.id]);

  // Release any active stream on unmount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSeq.current++;
      hls.current?.destroy();
      hls.current = null;
      if (streamToken.current) {
        void api('/stop', { body: { token: streamToken.current } }).catch(() => {});
        streamToken.current = null;
      }
    };
  }, []);

  const report = useCallback(
    async (final = false) => {
      if (!stream || !duration) return;
      const seconds = watched.current.total;
      watched.current.total = 0;
      const cur = offset + (video.current?.currentTime ?? time);
      const res = await api<{ blocked: string | null }>('/progress', {
        body: { ...base, type: target.type, id: target.id, time: cur, duration, watched: seconds },
      }).catch(() => null);
      if (res?.blocked && !final) {
        video.current?.pause();
        setError(res.blocked);
      }
    },
    [stream, offset, duration, target.type, target.id, time],
  );

  useEffect(() => {
    const t = window.setInterval(() => void report(), REPORT_MS);
    return () => window.clearInterval(t);
  }, [report]);

  const exit = useCallback(async () => {
    await report(true);
    if (streamToken.current) {
      void api('/stop', { body: { token: streamToken.current } }).catch(() => {});
      streamToken.current = null;
    }
    hls.current?.destroy();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    onExit();
  }, [report, onExit]);

  const seekTo = useCallback(
    (t: number) => {
      const el = video.current;
      if (!el || !stream) return;
      const clamped = Math.max(0, Math.min(Math.max(0, duration - 0.5), t));
      setEnded(false);
      setTime(clamped - offset);
      el.currentTime = Math.max(0, clamped - offset);
    },
    [duration, offset, stream],
  );

  const changeTracks = async (next: { aid?: number; sid?: number; subStyle?: Partial<RemoteSubStyle> }) => {
    const baseChoice = choiceRef.current ?? (stream ? { aid: stream.aid, sid: stream.sid, subStyle: stream.subStyle } : null);
    if (!stream || !baseChoice) return;
    const aid = next.aid !== undefined ? next.aid : baseChoice.aid;
    const sid = next.sid !== undefined ? next.sid : baseChoice.sid;
    const subStyle: RemoteSubStyle = { ...baseChoice.subStyle, ...next.subStyle };
    choiceRef.current = { aid, sid, subStyle };
    setStream((prev) =>
      prev
        ? {
            ...prev,
            aid,
            sid,
            subStyle,
            audioTracks: prev.audioTracks.map((a) => ({ ...a, selected: a.id === aid })),
            subTracks: prev.subTracks.map((t) => ({ ...t, selected: t.id === sid })),
          }
        : prev,
    );
    const cur = offset + (video.current?.currentTime ?? time);
    const prev = streamToken.current ?? undefined;
    streamToken.current = null;
    await loadStream({
      start: cur,
      aid: aid ?? undefined,
      sid,
      subStyle,
      prevToken: prev,
    });
  };

  const applySpeed = (s: number) => {
    setSpeed(s);
    if (video.current) video.current.playbackRate = s;
  };

  const poke = useCallback(() => {
    setControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!video.current?.paused && !panel) setControls(false);
    }, 3500);
  }, [panel]);

  useEffect(() => {
    poke();
  }, [poke]);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
    poke();
  }, [poke]);

  const fullscreen = useCallback(() => {
    const el = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const box = container.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else if (box?.requestFullscreen && !/iPhone|iPod/.test(navigator.userAgent)) {
      void box.requestFullscreen().catch(() => el?.webkitEnterFullscreen?.());
    } else {
      el?.webkitEnterFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const canPip =
    typeof document !== 'undefined' &&
    (document.pictureInPictureEnabled || typeof (HTMLVideoElement.prototype as unknown as { webkitSetPresentationMode?: unknown }).webkitSetPresentationMode === 'function');

  const togglePip = () => {
    const el = video.current as (HTMLVideoElement & {
      webkitPresentationMode?: string;
      webkitSetPresentationMode?: (m: string) => void;
    }) | null;
    if (!el) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    else if (el.requestPictureInPicture) void el.requestPictureInPicture().catch(() => {});
    else if (el.webkitSetPresentationMode) el.webkitSetPresentationMode(el.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  };

  const playNext = useCallback(async () => {
    if (!stream?.next) return;
    await report(true);
    onPlay(stream.next);
  }, [onPlay, report, stream?.next]);

  // Active intro / recap / credits segments.
  const activeSkip = useMemo(() => {
    const seg = stream?.segments.find((s) => (s.kind === 'intro' || s.kind === 'recap') && absolute >= s.start && absolute < s.end - 1);
    if (!seg) return null;
    const key = `${seg.kind}-${seg.start}`;
    return dismissedSeg === key ? null : { ...seg, key };
  }, [absolute, dismissedSeg, stream?.segments]);

  const creditsSeg = useMemo(() => stream?.segments.find((s) => s.kind === 'credits') ?? null, [stream?.segments]);
  const inCredits = creditsSeg ? absolute >= creditsSeg.start : duration > 300 && absolute >= duration - 210;
  const showNextPrompt = !!stream?.next && !ended && !creditsDismissed && creditsSeg != null && absolute >= creditsSeg.start;
  const stingerNote = stream?.stinger && inCredits ? stingerText(stream.stinger) : null;

  // 10s auto-advance countdown once credits begin on TV episodes.
  useEffect(() => {
    if (!showNextPrompt || paused) {
      setCountdown(null);
      return;
    }
    setCountdown(10);
    const t = window.setInterval(() => {
      setCountdown((c) => {
        if (c == null) return null;
        if (c <= 1) {
          window.clearInterval(t);
          void playNext();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [showNextPrompt, paused, playNext]);

  // Keyboard shortcuts (desktop / iPad keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key;
      if (k === ' ' || k === 'k' || k === 'K') {
        e.preventDefault();
        toggle();
      } else if (k === 'ArrowLeft' || k === 'j' || k === 'J') {
        e.preventDefault();
        seekTo(absolute - 10);
        poke();
      } else if (k === 'ArrowRight' || k === 'l' || k === 'L') {
        e.preventDefault();
        seekTo(absolute + 10);
        poke();
      } else if (k === 'ArrowUp') {
        e.preventDefault();
        const el = video.current;
        if (el) {
          el.muted = false;
          el.volume = Math.min(1, el.volume + 0.1);
        }
        poke();
      } else if (k === 'ArrowDown') {
        e.preventDefault();
        const el = video.current;
        if (el) el.volume = Math.max(0, el.volume - 0.1);
        poke();
      } else if (k === 'm' || k === 'M') {
        if (video.current) video.current.muted = !video.current.muted;
        poke();
      } else if (k === 'f' || k === 'F') {
        fullscreen();
      } else if (k === 's' || k === 'S') {
        setPanel((p) => (p === 'tracks' ? null : 'tracks'));
        poke();
      } else if ((k === 'c' || k === 'C') && stream?.chapters.length) {
        setPanel((p) => (p === 'chapters' ? null : 'chapters'));
        poke();
      } else if (k === '>' || k === '.') {
        const idx = SPEEDS.indexOf(speedRef.current);
        if (idx >= 0 && idx + 1 < SPEEDS.length) applySpeed(SPEEDS[idx + 1]);
        poke();
      } else if (k === '<' || k === ',') {
        const idx = SPEEDS.indexOf(speedRef.current);
        if (idx > 0) applySpeed(SPEEDS[idx - 1]);
        poke();
      } else if ((k === 'n' || k === 'N') && stream?.next) {
        void playNext();
      } else if (k === 'Escape') {
        if (panel) setPanel(null);
        else void exit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [absolute, exit, fullscreen, panel, playNext, poke, seekTo, stream?.chapters.length, stream?.next, toggle]);

  const currentChapterIdx = useMemo(() => {
    if (!stream?.chapters.length) return -1;
    let idx = 0;
    for (let i = 0; i < stream.chapters.length; i++) {
      if (absolute >= stream.chapters[i].time - 0.5) idx = i;
    }
    return idx;
  }, [absolute, stream?.chapters]);

  const onVideoClick = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (panel) {
      setPanel(null);
      return;
    }
    // Touch double-tap left/right third seeks ±10s.
    const isTouch = window.matchMedia?.('(pointer: coarse)').matches;
    if (isTouch) {
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / Math.max(1, rect.width);
      const side: 'left' | 'right' | null = frac < 0.35 ? 'left' : frac > 0.65 ? 'right' : null;
      const now = Date.now();
      if (side && lastTap.current && lastTap.current.side === side && now - lastTap.current.at < 320) {
        lastTap.current = null;
        seekTo(absolute + (side === 'left' ? -10 : 10));
        setRipple(side);
        window.setTimeout(() => setRipple(null), 500);
        poke();
        return;
      }
      if (side) lastTap.current = { at: now, side };
      setControls((c) => !c);
      return;
    }
    toggle();
  };

  const progressPct = duration > 0 ? Math.min(100, (absolute / duration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, ((offset + bufferedEnd) / duration) * 100) : 0;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div ref={container} className="fixed inset-0 select-none bg-black text-white" onMouseMove={poke}>
      <video
        ref={video}
        playsInline
        className="h-full w-full"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.playbackRate = speedRef.current;
          if (pendingSeek.current != null) {
            const want = pendingSeek.current;
            pendingSeek.current = null;
            if (Math.abs(el.currentTime - want) > 1.5) el.currentTime = want;
          }
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          const t = el.currentTime;
          const dt = t - watched.current.last;
          if (dt > 0 && dt < 2.5) watched.current.total += dt;
          watched.current.last = t;
          setTime(t);
          if (el.buffered.length) setBufferedEnd(el.buffered.end(el.buffered.length - 1));
        }}
        onProgress={(e) => {
          const el = e.currentTarget;
          if (el.buffered.length) setBufferedEnd(el.buffered.end(el.buffered.length - 1));
        }}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onPlaying={() => {
          setLoading(false);
          setPaused(false);
          setError('');
        }}
        onCanPlay={() => setLoading(false)}
        onSeeking={() => setLoading(true)}
        onSeeked={() => setLoading(false)}
        onPause={() => {
          setPaused(true);
          void report();
        }}
        onWaiting={() => setLoading(true)}
        onEnded={() => {
          setEnded(true);
          setLoading(false);
          void report(true);
        }}
        onClick={onVideoClick}
        onDoubleClick={() => {
          if (!window.matchMedia?.('(pointer: coarse)').matches) fullscreen();
        }}
      />

      {ripple && (
        <div
          className={`pointer-events-none absolute inset-y-0 flex w-1/3 items-center justify-center bg-white/10 text-sm font-semibold ${
            ripple === 'left' ? 'left-0 rounded-r-full' : 'right-0 rounded-l-full'
          }`}
        >
          {ripple === 'left' ? '−10s' : '+10s'}
        </div>
      )}

      {loading && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-nf-red" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <p className="max-w-md text-lg">{error}</p>
          <button onClick={() => void exit()} className="nf-btn-red px-6 py-2">
            Back
          </button>
        </div>
      )}

      {/* Stinger ("Stay for the credits") reminder */}
      {stingerNote && !ended && (
        <div className="pointer-events-none absolute left-1/2 top-20 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/20 bg-black/80 px-4 py-2 text-xs font-medium shadow-lg backdrop-blur sm:text-sm">
          <Sparkles className="h-4 w-4 shrink-0 text-[#f5c518]" />
          <span>{stingerNote}</span>
        </div>
      )}

      {/* Skip Intro / Skip Recap */}
      {activeSkip && !ended && !error && (
        <div className="absolute bottom-28 right-4 z-20 flex items-center gap-2 sm:right-8">
          <button
            onClick={() => {
              seekTo(activeSkip.end);
              setDismissedSeg(activeSkip.key);
            }}
            className="rounded border border-white/80 bg-white px-5 py-2 text-sm font-bold text-black shadow-lg transition hover:bg-white/90 sm:text-base"
          >
            {activeSkip.kind === 'recap' ? 'Skip Recap' : 'Skip Intro'}
          </button>
          <button
            onClick={() => setDismissedSeg(activeSkip.key)}
            aria-label="Dismiss"
            className="rounded-full bg-black/60 p-2 text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Next Episode countdown during credits */}
      {showNextPrompt && stream?.next && (
        <div className="absolute bottom-28 right-4 z-20 flex flex-col gap-2 rounded-lg border border-white/15 bg-[#181818]/95 p-4 shadow-2xl backdrop-blur sm:right-8 sm:min-w-[280px]">
          <div className="text-xs uppercase tracking-wider text-nf-secondary">Up next{countdown != null ? ` in ${countdown}s` : ''}</div>
          <div className="truncate text-sm font-semibold sm:text-base">{stream.next.label}</div>
          <div className="mt-1 flex gap-2">
            <button onClick={() => void playNext()} className="nf-btn-play flex-1 py-2 text-sm">
              <Play className="h-4 w-4 fill-black" strokeWidth={0} /> Next Episode
            </button>
            <button onClick={() => setCreditsDismissed(true)} className="nf-btn-info px-4 py-2 text-sm">
              Watch Credits
            </button>
          </div>
        </div>
      )}

      {/* Ended overlay */}
      {ended && stream?.next && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <p className="text-sm uppercase tracking-widest text-nf-secondary">Up next</p>
          <p className="text-xl font-semibold sm:text-2xl">{stream.next.label}</p>
          <div className="flex gap-3">
            <button onClick={() => void playNext()} className="nf-btn-play px-6">
              <Play className="h-5 w-5 fill-black" strokeWidth={0} /> Play Next
            </button>
            <button onClick={() => void exit()} className="nf-btn-info px-6">
              Back
            </button>
          </div>
        </div>
      )}

      {/* Audio & Subtitles / Speed / Chapters popovers */}
      {panel && stream && (
        <div
          className="absolute inset-x-3 bottom-24 z-30 mx-auto max-w-xl rounded-xl border border-white/15 bg-[#181818]/95 p-4 shadow-2xl backdrop-blur sm:inset-x-auto sm:right-6 sm:w-[440px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
            <h3 className="text-sm font-bold uppercase tracking-wider text-white/90">
              {panel === 'tracks' ? 'Audio & Subtitles' : panel === 'speed' ? 'Playback Speed' : 'Chapters'}
            </h3>
            <button onClick={() => setPanel(null)} aria-label="Close menu" className="rounded-full p-1 text-white/70 hover:bg-white/10 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>

          {panel === 'tracks' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-nf-muted">Audio</div>
                  <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
                    {stream.audioTracks.length === 0 && <div className="px-2 py-1 text-xs text-nf-muted">Default audio</div>}
                    {stream.audioTracks.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => {
                          setPanel(null);
                          void changeTracks({ aid: a.id });
                        }}
                        className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition ${
                          a.selected ? 'bg-white/15 font-semibold text-white' : 'text-nf-secondary hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        <Check className={`h-4 w-4 shrink-0 ${a.selected ? 'opacity-100' : 'opacity-0'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{a.label}</div>
                          {a.detail && <div className="truncate text-[11px] text-nf-muted">{a.detail}</div>}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-nf-muted">Subtitles</div>
                  <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
                    <button
                      onClick={() => {
                        setPanel(null);
                        void changeTracks({ sid: 0 });
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition ${
                        stream.sid === 0 ? 'bg-white/15 font-semibold text-white' : 'text-nf-secondary hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      <Check className={`h-4 w-4 shrink-0 ${stream.sid === 0 ? 'opacity-100' : 'opacity-0'}`} />
                      <span>Off</span>
                    </button>
                    {stream.subTracks.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setPanel(null);
                          void changeTracks({ sid: s.id });
                        }}
                        className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition ${
                          s.selected ? 'bg-white/15 font-semibold text-white' : 'text-nf-secondary hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        <Check className={`h-4 w-4 shrink-0 ${s.selected ? 'opacity-100' : 'opacity-0'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{s.label}</div>
                          {s.detail && <div className="truncate text-[11px] text-nf-muted">{s.detail}</div>}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {stream.subTracks.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-nf-muted">Size</span>
                    {SUB_SIZES.map((sz) => (
                      <button
                        key={sz.id}
                        onClick={() => void changeTracks({ subStyle: { size: sz.id } })}
                        className={`rounded px-2 py-1 font-medium ${
                          stream.subStyle.size === sz.id ? 'bg-white text-black' : 'bg-white/10 text-nf-secondary hover:text-white'
                        }`}
                      >
                        {sz.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-nf-muted">Window</span>
                    {SUB_BACKGROUNDS.map((bg) => (
                      <button
                        key={bg.id}
                        onClick={() => void changeTracks({ subStyle: { background: bg.id } })}
                        className={`rounded px-2 py-1 font-medium ${
                          stream.subStyle.background === bg.id ? 'bg-white text-black' : 'bg-white/10 text-nf-secondary hover:text-white'
                        }`}
                      >
                        {bg.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {panel === 'speed' && (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    applySpeed(s);
                    setPanel(null);
                  }}
                  className={`rounded-md py-2 text-center text-sm font-semibold transition ${
                    speed === s ? 'bg-white text-black' : 'bg-white/10 text-nf-secondary hover:bg-white/20 hover:text-white'
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
          )}

          {panel === 'chapters' && (
            <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {stream.chapters.map((c, idx) => (
                <button
                  key={`${c.time}-${idx}`}
                  onClick={() => {
                    seekTo(c.time);
                    setPanel(null);
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm transition ${
                    idx === currentChapterIdx ? 'bg-white/15 font-semibold text-white' : 'text-nf-secondary hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <span className="truncate">{c.title || `Chapter ${idx + 1}`}</span>
                  <span className="shrink-0 font-mono text-xs text-nf-muted">{fmtTime(c.time)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Top & bottom player chrome */}
      <div className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${controls || paused || !!panel ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/85 to-transparent px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))]">
          <button onClick={() => void exit()} aria-label="Back" className="rounded-full p-1.5 hover:bg-white/10">
            <ArrowLeft className="h-7 w-7" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold sm:text-lg">{stream?.title}</div>
            {stream?.subtitle && <div className="truncate text-xs text-nf-secondary sm:text-sm">{stream.subtitle}</div>}
          </div>
        </div>

        <div className="pointer-events-auto absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-10">
          {/* Timeline scrubber with buffer bar & chapter ticks */}
          <div className="flex items-center gap-3">
            <span className="w-12 text-right font-mono text-xs tabular-nums sm:w-14">{fmtTime(absolute)}</span>
            <div className="group relative flex h-5 flex-1 items-center">
              <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-all group-hover:h-1.5">
                <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${bufferedPct}%` }} />
                <div className="absolute inset-y-0 left-0 bg-nf-red" style={{ width: `${progressPct}%` }} />
                {duration > 0 &&
                  stream?.chapters.map((c, i) =>
                    c.time > 1 && c.time < duration - 1 ? (
                      <span
                        key={i}
                        className="absolute inset-y-0 w-[2px] bg-black/70"
                        style={{ left: `${(c.time / duration) * 100}%` }}
                      />
                    ) : null,
                  )}
              </div>
              <input
                type="range"
                aria-label="Seek"
                min={0}
                max={Math.max(1, duration)}
                step={0.5}
                value={Math.min(absolute, Math.max(1, duration))}
                onChange={(e) => seekTo(Number(e.target.value))}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>
            <button
              onClick={() => setShowRemaining((r) => !r)}
              className="w-14 text-left font-mono text-xs tabular-nums text-nf-secondary hover:text-white"
              title="Toggle remaining time"
            >
              {showRemaining ? `−${fmtTime(Math.max(0, duration - absolute))}` : fmtTime(duration)}
            </button>
          </div>

          {/* Transport & utility buttons */}
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 sm:gap-5">
              <button onClick={toggle} aria-label={paused ? 'Play' : 'Pause'} className="rounded-full p-1.5 hover:bg-white/10">
                {paused ? <Play className="h-7 w-7 fill-white" strokeWidth={0} /> : <Pause className="h-7 w-7 fill-white" strokeWidth={0} />}
              </button>
              <button onClick={() => seekTo(absolute - 10)} aria-label="Back 10 seconds" className="rounded-full p-1.5 hover:bg-white/10">
                <RotateCcw className="h-6 w-6" />
              </button>
              <button onClick={() => seekTo(absolute + 10)} aria-label="Forward 10 seconds" className="rounded-full p-1.5 hover:bg-white/10">
                <RotateCw className="h-6 w-6" />
              </button>
              {stream?.next && (
                <button onClick={() => void playNext()} aria-label="Next episode" title={`Next: ${stream.next.label}`} className="rounded-full p-1.5 hover:bg-white/10">
                  <SkipForward className="h-6 w-6" />
                </button>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (video.current) video.current.muted = !video.current.muted;
                  }}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  className="rounded-full p-1.5 hover:bg-white/10"
                >
                  <VolumeIcon className="h-6 w-6" />
                </button>
                <input
                  type="range"
                  aria-label="Volume"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => {
                    const el = video.current;
                    if (!el) return;
                    const v = Number(e.target.value);
                    el.volume = v;
                    el.muted = v === 0;
                  }}
                  className="hidden h-1 w-20 accent-white sm:block"
                />
              </div>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-3">
              {!!stream?.chapters.length && (
                <button
                  onClick={() => setPanel((p) => (p === 'chapters' ? null : 'chapters'))}
                  aria-label="Chapters"
                  title="Chapters (C)"
                  className={`rounded-full p-2 hover:bg-white/10 ${panel === 'chapters' ? 'bg-white/15' : ''}`}
                >
                  <ListVideo className="h-5 w-5 sm:h-6 sm:w-6" />
                </button>
              )}
              <button
                onClick={() => setPanel((p) => (p === 'speed' ? null : 'speed'))}
                aria-label="Playback speed"
                title="Playback speed"
                className={`flex items-center gap-1 rounded-full px-2 py-1.5 text-xs font-semibold hover:bg-white/10 ${panel === 'speed' ? 'bg-white/15' : ''}`}
              >
                <Gauge className="h-5 w-5 sm:h-6 sm:w-6" />
                {speed !== 1 && <span>{speed}×</span>}
              </button>
              <button
                onClick={() => setPanel((p) => (p === 'tracks' ? null : 'tracks'))}
                aria-label="Audio & Subtitles"
                title="Audio & Subtitles (S)"
                className={`relative rounded-full p-2 hover:bg-white/10 ${panel === 'tracks' ? 'bg-white/15' : ''}`}
              >
                <MessageSquareText className="h-5 w-5 sm:h-6 sm:w-6" />
                {(stream?.sid ?? 0) > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-nf-red" />}
              </button>
              {canPip && (
                <button onClick={togglePip} aria-label="Picture in Picture" title="Picture in Picture" className="hidden rounded-full p-2 hover:bg-white/10 sm:inline-flex">
                  <PictureInPicture2 className="h-5 w-5 sm:h-6 sm:w-6" />
                </button>
              )}
              <button onClick={fullscreen} aria-label="Full screen" title="Full screen (F)" className="rounded-full p-2 hover:bg-white/10">
                {isFullscreen ? <Minimize className="h-5 w-5 sm:h-6 sm:w-6" /> : <Maximize className="h-5 w-5 sm:h-6 sm:w-6" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
