import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Loader2,
  Maximize,
  MessageSquareText,
  Minimize,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { RemoteCommandAction, RemoteNowPlaying, RemoteProfile } from './types';
import { api, ApiStatusError, AuthError, qs } from './api';
import { formatClock } from '../lib/format';
import { errorMessage } from '../lib/errors';

type Who = { id: number; key?: string; profile: RemoteProfile };

export interface NowPlaying {
  /** What plays on the PC, or null when nothing does (or it's another profile's). */
  np: RemoteNowPlaying | null;
  /** When `np` was fetched, for moving the progress bar between polls. */
  at: number;
  /** The computer's name, once known. */
  pc: string | null;
  /** e.g. "Playing on another profile". */
  blocked: string | null;
  error: string;
  send: (action: RemoteCommandAction, value?: unknown) => Promise<void>;
  refresh: () => void;
}

/** Polls the desktop app's player while the browser app is open (every second while something plays). */
export function useNowPlaying(who: Who, enabled: boolean, onAuthError: (e: unknown) => void): NowPlaying {
  const [np, setNp] = useState<RemoteNowPlaying | null>(null);
  const [at, setAt] = useState(0);
  const [pc, setPc] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);
  const active = useRef(false);

  const poll = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    try {
      const s = await api<RemoteNowPlaying>(`/remote/state${qs({ profile: who.id, key: who.key })}`);
      setPc(s.pc);
      setBlocked(null);
      setNp(s.active ? s : null);
      setAt(Date.now());
      active.current = s.active;
    } catch (e) {
      onAuthError(e);
      if (e instanceof AuthError) return;
      setNp(null);
      active.current = false;
      if (e instanceof ApiStatusError && e.status === 403) setBlocked(e.message);
    }
    if (!document.hidden) timer.current = window.setTimeout(() => void poll(), active.current ? 1000 : 4000);
  }, [who, onAuthError]);

  useEffect(() => {
    if (!enabled) return;
    void poll();
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [enabled, poll]);

  const send = useCallback(
    async (action: RemoteCommandAction, value?: unknown) => {
      setError('');
      // Show the change right away; the next poll confirms it.
      setNp((cur) => {
        if (!cur) return cur;
        if (action === 'toggle') return { ...cur, paused: !cur.paused };
        if (action === 'volume') return { ...cur, volume: Number(value), muted: Number(value) > 0 ? false : cur.muted };
        if (action === 'mute') return { ...cur, muted: !!value };
        if (action === 'seek') return { ...cur, time: Number(value) };
        if (action === 'skip') return { ...cur, time: Math.max(0, (cur.time ?? 0) + Number(value)) };
        return cur;
      });
      if (action === 'seek' || action === 'skip') setAt(Date.now());
      try {
        await api(`/remote/command`, { body: { profile: who.id, key: who.key, action, value } });
      } catch (e) {
        onAuthError(e);
        setError(errorMessage(e));
      }
      window.setTimeout(() => void poll(), action === 'next' || action === 'stop' ? 900 : 300);
    },
    [who, poll, onAuthError],
  );

  return { np, at, pc, blocked, error, send, refresh: () => void poll() };
}

/** Media time now, moving smoothly between polls while playing. */
function useLiveTime(np: RemoteNowPlaying, at: number) {
  const [, tick] = useState(0);
  const moving = !np.paused && !np.buffering;
  useEffect(() => {
    if (!moving) return;
    const t = window.setInterval(() => tick((x) => x + 1), 250);
    return () => window.clearInterval(t);
  }, [moving]);
  const t = (np.time ?? 0) + (moving ? Math.min(2, (Date.now() - at) / 1000) : 0);
  return np.duration ? Math.min(t, np.duration) : t;
}

const where = (np: RemoteNowPlaying) => (np.source === 'cast' && np.castDevice ? np.castDevice : np.pc);

/** The "Playing on <PC>" strip above the bottom edge of the browse screens. */
export function NowPlayingBar({ now, onOpen }: { now: NowPlaying; onOpen: () => void }) {
  const { np, at, send } = now;
  if (!np) return null;
  return <Bar np={np} at={at} send={send} onOpen={onOpen} />;
}

function Bar({ np, at, send, onOpen }: { np: RemoteNowPlaying; at: number; send: NowPlaying['send']; onOpen: () => void }) {
  const time = useLiveTime(np, at);
  const ratio = np.duration ? Math.min(1, time / np.duration) : 0;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-xl overflow-hidden rounded-lg border border-white/10 bg-[#232323]/95 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-3 p-2">
          <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label="Open remote">
            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded bg-white/10">
              {np.poster || np.art ? <img src={np.poster ?? np.art ?? ''} alt="" className="h-full w-full object-cover" /> : <Monitor className="m-3 h-6 w-6 text-white/60" />}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{np.title}</div>
              <div className="flex items-center gap-1 truncate text-xs text-nf-secondary">
                <Monitor className="h-3 w-3 shrink-0 text-nf-red" />
                <span className="truncate">Playing on {where(np)}</span>
              </div>
            </div>
          </button>
          <button
            onClick={() => void send('toggle')}
            aria-label={np.paused ? 'Play' : 'Pause'}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20"
          >
            {np.buffering && !np.paused ? <Loader2 className="h-6 w-6 animate-spin" /> : np.paused ? <Play className="h-7 w-7 fill-white" strokeWidth={0} /> : <Pause className="h-7 w-7 fill-white" strokeWidth={0} />}
          </button>
        </div>
        {np.duration ? (
          <div className="h-0.5 w-full bg-white/15">
            <div className="h-full bg-nf-red" style={{ width: `${ratio * 100}%` }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Scrubber({ time, duration, onSeek }: { time: number; duration: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const ratioAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width));
  };
  const shown = drag ?? (duration ? time / duration : 0);
  return (
    <div>
      <div
        ref={ref}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown * duration)}
        className="relative flex h-10 touch-none items-center"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(ratioAt(e.clientX));
        }}
        onPointerMove={(e) => drag != null && setDrag(ratioAt(e.clientX))}
        onPointerUp={(e) => {
          if (drag == null) return;
          onSeek(ratioAt(e.clientX) * duration);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <div className="relative h-1.5 w-full rounded-full bg-white/25">
          <div className="absolute inset-y-0 left-0 rounded-full bg-nf-red" style={{ width: `${shown * 100}%` }} />
          <div
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-nf-red shadow transition-[width,height] ${drag != null ? 'h-6 w-6' : 'h-4 w-4'}`}
            style={{ left: `${shown * 100}%` }}
          />
        </div>
      </div>
      <div className="flex justify-between text-xs tabular-nums text-nf-secondary">
        <span>{formatClock(shown * duration)}</span>
        <span>-{formatClock(Math.max(0, duration - shown * duration))}</span>
      </div>
    </div>
  );
}

function Volume({ np, send }: { np: RemoteNowPlaying; send: NowPlaying['send'] }) {
  const [local, setLocal] = useState<number | null>(null);
  const last = useRef(0);
  const value = local ?? (np.muted ? 0 : (np.volume ?? 0));
  const push = (v: number, force = false) => {
    if (!force && Date.now() - last.current < 250) return;
    last.current = Date.now();
    void send('volume', v);
  };
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => void send('mute', !np.muted)}
        aria-label={np.muted ? 'Unmute' : 'Mute'}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20"
      >
        {np.muted || value === 0 ? <VolumeX className="h-6 w-6" /> : <Volume2 className="h-6 w-6" />}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        aria-label="Volume"
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          push(v);
        }}
        onPointerUp={() => {
          if (local != null) push(local, true);
          setLocal(null);
        }}
        onTouchEnd={() => {
          if (local != null) push(local, true);
          setLocal(null);
        }}
        className="h-10 flex-1"
        style={{ accentColor: '#E50914' }}
      />
      <span className="w-8 text-right text-xs tabular-nums text-nf-secondary">{value}</span>
    </div>
  );
}

function TrackSheet({ np, send, onClose }: { np: RemoteNowPlaying; send: NowPlaying['send']; onClose: () => void }) {
  const row = (selected: boolean, label: string, detail: string | null, onClick: () => void, key: string) => (
    <button
      key={key}
      onClick={() => {
        onClose();
        onClick();
      }}
      className={`flex w-full items-center gap-3 rounded px-3 py-3 text-left ${selected ? 'bg-white/15 font-semibold text-white' : 'text-nf-secondary active:bg-white/10'}`}
    >
      <Check className={`h-5 w-5 shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{label}</div>
        {detail && <div className="truncate text-xs text-nf-muted">{detail}</div>}
      </div>
    </button>
  );
  const subsOff = !np.subTracks?.some((s) => s.selected);
  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/60" onClick={onClose}>
      <div
        className="max-h-[80dvh] w-full overflow-y-auto rounded-t-2xl border-t border-white/10 bg-[#181818] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:mx-auto sm:max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wider">Audio & Subtitles</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-2 text-white/70 active:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wider text-nf-muted">Audio</div>
        {np.audioTracks?.length ? np.audioTracks.map((a) => row(a.selected, a.label, a.detail, () => void send('audio', a.id), `a${a.id}`)) : <div className="px-3 py-2 text-sm text-nf-muted">Default audio</div>}
        <div className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-nf-muted">Subtitles</div>
        {row(subsOff, 'Off', null, () => void send('subtitle', 0), 'off')}
        {np.subTracks?.map((s) => row(s.selected, s.label, s.detail, () => void send('subtitle', s.id), `s${s.id}`))}
      </div>
    </div>
  );
}

const round = 'flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20 disabled:opacity-30';

/** The full remote: artwork, scrubbing, transport, volume, tracks and full screen on the PC. */
export function RemoteSheet({ now, onClose }: { now: NowPlaying; onClose: () => void }) {
  const { np, at, send, error } = now;
  const [tracks, setTracks] = useState(false);
  useEffect(() => {
    if (!np) onClose();
  }, [np, onClose]);
  if (!np) return null;
  return <Sheet np={np} at={at} send={send} error={error} onClose={onClose} tracks={tracks} setTracks={setTracks} />;
}

function Sheet({
  np,
  at,
  send,
  error,
  onClose,
  tracks,
  setTracks,
}: {
  np: RemoteNowPlaying;
  at: number;
  send: NowPlaying['send'];
  error: string;
  onClose: () => void;
  tracks: boolean;
  setTracks: (v: boolean) => void;
}) {
  const time = useLiveTime(np, at);
  const can = np.can ?? { seek: false, skip: false, volume: false, tracks: false, next: false, fullscreen: false };
  const hasTracks = can.tracks && ((np.audioTracks?.length ?? 0) > 1 || (np.subTracks?.length ?? 0) > 0);
  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-nf-bg">
      {np.art && <img src={np.art} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-30 blur-2xl" />}
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-nf-bg/80 to-nf-bg" />
      <div className="relative mx-auto flex w-full max-w-xl flex-1 flex-col px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2">
          <button onClick={onClose} aria-label="Close remote" className={`${round} h-12 w-12`}>
            <ChevronDown className="h-7 w-7" />
          </button>
          <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-sm text-nf-secondary">
            <Monitor className="h-4 w-4 shrink-0 text-nf-red" />
            <span className="truncate">Playing on {where(np)}</span>
          </div>
          <div className="h-12 w-12" />
        </div>

        <div className="mt-4 flex flex-1 flex-col justify-center">
          <div className="mx-auto aspect-video w-full overflow-hidden rounded-lg bg-white/5 shadow-2xl">
            {np.art ? <img src={np.art} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Monitor className="h-14 w-14 text-white/30" /></div>}
          </div>
          <div className="mt-5 text-center">
            {np.logo ? <img src={np.logo} alt={np.title} className="mx-auto max-h-16 max-w-[70%] object-contain" /> : <h1 className="text-2xl font-black">{np.title}</h1>}
            {np.subtitle && <p className="mt-1 text-nf-secondary">{np.subtitle}</p>}
            {np.prompt && (
              <p className="mt-2 text-sm text-[#ffd76a]">
                {np.prompt === 'still-watching' ? 'Asking “Are you still watching?” — press play to continue.' : np.prompt === 'sleep-ended' ? 'Sleep timer ended — press play to continue.' : 'Paused by this profile’s viewing limits.'}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 space-y-4">
          {can.seek && np.duration ? <Scrubber time={time} duration={np.duration} onSeek={(t) => void send('seek', t)} /> : np.type === 'live' ? <div className="text-center text-xs font-bold uppercase tracking-widest text-nf-red">Live</div> : null}

          <div className="flex items-center justify-center gap-6">
            <button onClick={() => void send('skip', -10)} disabled={!can.skip} aria-label="Back 10 seconds" className={`${round} h-14 w-14`}>
              <RotateCcw className="h-8 w-8" />
            </button>
            <button
              onClick={() => void send('toggle')}
              aria-label={np.paused ? 'Play' : 'Pause'}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-black active:scale-95"
            >
              {np.buffering && !np.paused ? <Loader2 className="h-9 w-9 animate-spin" /> : np.paused ? <Play className="ml-1 h-10 w-10 fill-black" strokeWidth={0} /> : <Pause className="h-10 w-10 fill-black" strokeWidth={0} />}
            </button>
            <button onClick={() => void send('skip', 10)} disabled={!can.skip} aria-label="Forward 10 seconds" className={`${round} h-14 w-14`}>
              <RotateCw className="h-8 w-8" />
            </button>
          </div>

          {can.volume && np.volume != null && <Volume np={np} send={send} />}

          <div className="flex items-center justify-around border-t border-white/10 pt-3">
            {hasTracks && (
              <button onClick={() => setTracks(true)} className="flex min-w-[4rem] flex-col items-center gap-1 p-2 text-xs text-nf-secondary active:text-white">
                <MessageSquareText className="h-6 w-6" /> Audio & Subs
              </button>
            )}
            {can.next && (
              <button onClick={() => void send('next')} className="flex min-w-[4rem] flex-col items-center gap-1 p-2 text-xs text-nf-secondary active:text-white" title={np.next ?? undefined}>
                <SkipForward className="h-6 w-6" /> Next Episode
              </button>
            )}
            {can.fullscreen && (
              <button onClick={() => void send('fullscreen')} className="flex min-w-[4rem] flex-col items-center gap-1 p-2 text-xs text-nf-secondary active:text-white">
                {np.fullscreen ? <Minimize className="h-6 w-6" /> : <Maximize className="h-6 w-6" />} {np.fullscreen ? 'Exit Full Screen' : 'Full Screen'}
              </button>
            )}
            <button onClick={() => void send('stop')} className="flex min-w-[4rem] flex-col items-center gap-1 p-2 text-xs text-nf-secondary active:text-white">
              <Square className="h-6 w-6" /> Stop
            </button>
          </div>
          {error && <p className="text-center text-sm text-nf-red">{error}</p>}
        </div>
      </div>
      {tracks && <TrackSheet np={np} send={send} onClose={() => setTracks(false)} />}
    </div>
  );
}
