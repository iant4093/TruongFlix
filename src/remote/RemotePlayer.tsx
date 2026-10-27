import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { ArrowLeft, Loader2, Maximize, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import type { RemotePlayable, RemoteProfile, RemoteStream } from './types';
import { api, fmtTime } from './api';

type Who = { id: number; key?: string; profile: RemoteProfile };

const REPORT_MS = 10_000;

/** Full-screen player for the browser app. Converted streams start at `offset`; times shown are absolute. */
export default function RemotePlayer({ who, target, onExit, onPlay }: { who: Who; target: RemotePlayable; onExit: () => void; onPlay: (t: RemotePlayable) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [stream, setStream] = useState<RemoteStream | null>(null);
  const [offset, setOffset] = useState(0);
  const [time, setTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [controls, setControls] = useState(true);
  const [ended, setEnded] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const watched = useRef({ last: 0, total: 0 });

  const base = { profile: who.id, key: who.key };

  /** Points the <video> at a stream URL (HLS through hls.js where the browser lacks it). */
  const attach = useCallback((url: string, startAt: number) => {
    const el = video.current;
    if (!el) return;
    hls.current?.destroy();
    hls.current = null;
    const isHls = url.includes('.m3u8');
    // hls.js wherever Media Source is available (it handles growing playlists consistently);
    // native HLS only where it isn't (older iPhones).
    if (isHls && Hls.isSupported()) {
      const h = new Hls({ startPosition: 0, maxBufferLength: 60 });
      h.loadSource(url);
      h.attachMedia(el);
      h.on(Hls.Events.ERROR, (_, d) => d.fatal && setError('Playback failed. Try again.'));
      hls.current = h;
    } else {
      el.src = url;
    }
    el.currentTime = startAt;
    void el.play().catch(() => setPaused(true));
  }, []);

  // Start playback.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setEnded(false);
    api<RemoteStream>('/play', { body: { ...base, type: target.type, id: target.id, start: target.resume >= 0 ? target.resume : undefined } })
      .then((s) => {
        if (!alive) {
          void api('/stop', { body: { token: s.token } }).catch(() => {});
          return;
        }
        setStream(s);
        setOffset(s.offset);
        // Direct files seek natively; converted streams already start at the resume point.
        attach(s.url, s.mode === 'direct' ? s.start : 0);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [target.type, target.id]);

  const absolute = offset + time;
  const duration = stream?.duration || 0;

  const report = useCallback(
    async (final = false) => {
      if (!stream || !duration) return;
      const seconds = watched.current.total;
      watched.current.total = 0;
      const res = await api<{ blocked: string | null }>('/progress', { body: { ...base, type: target.type, id: target.id, time: offset + (video.current?.currentTime ?? 0), duration, watched: seconds } }).catch(() => null);
      if (res?.blocked && !final) {
        video.current?.pause();
        setError(res.blocked);
      }
    },
    [stream, offset, duration, target.type, target.id],
  );

  useEffect(() => {
    const t = window.setInterval(() => void report(), REPORT_MS);
    return () => window.clearInterval(t);
  }, [report]);

  // Save progress and free the conversion when leaving.
  const exit = useCallback(async () => {
    await report(true);
    if (stream) void api('/stop', { body: { token: stream.token } });
    hls.current?.destroy();
    onExit();
  }, [report, stream, onExit]);

  const seekTo = async (t: number) => {
    const el = video.current;
    if (!el || !stream) return;
    const target = Math.max(0, Math.min(duration - 1, t));
    if (stream.mode === 'direct') {
      el.currentTime = target;
      return;
    }
    // Inside what's already converted: seek in place. Further ahead: restart the conversion there.
    const local = target - offset;
    const end = el.seekable.length ? el.seekable.end(el.seekable.length - 1) : 0;
    if (local >= 0 && local <= end - 2) {
      el.currentTime = local;
      return;
    }
    setLoading(true);
    const res = await api<{ url: string; offset: number }>('/seek', { body: { token: stream.token, time: target } });
    setOffset(res.offset);
    setTime(0);
    attach(`${res.url}?r=${Date.now()}`, 0);
  };

  const poke = () => {
    setControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => !video.current?.paused && setControls(false), 3500);
  };
  useEffect(poke, []);

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
    poke();
  };

  const fullscreen = () => {
    const el = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const root = document.documentElement;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (root.requestFullscreen) void root.requestFullscreen().catch(() => el?.webkitEnterFullscreen?.());
    else el?.webkitEnterFullscreen?.();
  };

  return (
    <div className="fixed inset-0 bg-black text-white" onMouseMove={poke} onClick={poke}>
      <video
        ref={video}
        playsInline
        className="h-full w-full"
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          const dt = t - watched.current.last;
          if (dt > 0 && dt < 2) watched.current.total += dt;
          watched.current.last = t;
          setTime(t);
        }}
        onPlaying={() => {
          setLoading(false);
          setPaused(false);
          setError('');
        }}
        onPause={() => {
          setPaused(true);
          void report();
        }}
        onWaiting={() => setLoading(true)}
        onEnded={() => {
          setEnded(true);
          void report(true);
        }}
        onClick={toggle}
      />

      {loading && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-nf-red" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 px-6 text-center">
          <p className="max-w-md text-lg">{error}</p>
          <button onClick={() => void exit()} className="nf-btn-red px-6 py-2">
            Back
          </button>
        </div>
      )}
      {ended && stream?.next && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80">
          <p className="text-nf-secondary">Up next</p>
          <p className="text-xl font-semibold">{stream.next.label}</p>
          <div className="flex gap-3">
            <button onClick={() => onPlay(stream.next!)} className="nf-btn-play px-6">
              <Play className="h-5 w-5 fill-black" strokeWidth={0} /> Play next
            </button>
            <button onClick={() => void exit()} className="nf-btn-info px-6">
              Back
            </button>
          </div>
        </div>
      )}

      <div className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${controls || paused ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))]">
          <button onClick={() => void exit()} aria-label="Back" className="p-1">
            <ArrowLeft className="h-7 w-7" />
          </button>
          <div className="min-w-0">
            <div className="truncate font-semibold">{stream?.title}</div>
            {stream?.subtitle && <div className="truncate text-sm text-nf-secondary">{stream.subtitle}</div>}
          </div>
        </div>
        <div className="pointer-events-auto absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-10">
          <div className="flex items-center gap-3">
            <span className="w-14 text-right text-xs tabular-nums">{fmtTime(absolute)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={1}
              value={Math.min(absolute, duration)}
              onChange={(e) => void seekTo(Number(e.target.value))}
              className="h-1 flex-1 accent-[#e50914]"
            />
            <span className="w-14 text-xs tabular-nums text-nf-secondary">{fmtTime(duration)}</span>
          </div>
          <div className="mt-3 flex items-center justify-center gap-8">
            <button onClick={() => void seekTo(absolute - 10)} aria-label="Back 10 seconds">
              <RotateCcw className="h-7 w-7" />
            </button>
            <button onClick={toggle} aria-label={paused ? 'Play' : 'Pause'} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15">
              {paused ? <Play className="ml-1 h-8 w-8 fill-white" strokeWidth={0} /> : <Pause className="h-8 w-8 fill-white" strokeWidth={0} />}
            </button>
            <button onClick={() => void seekTo(absolute + 10)} aria-label="Forward 10 seconds">
              <RotateCw className="h-7 w-7" />
            </button>
            <button onClick={fullscreen} aria-label="Full screen" className="absolute right-4">
              <Maximize className="h-6 w-6" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
