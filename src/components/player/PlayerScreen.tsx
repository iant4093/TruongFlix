import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Check,
  Gauge,
  Maximize,
  MessageSquareText,
  Minimize,
  Moon,
  Pause,
  PictureInPicture2,
  Play,
  SkipForward,
  Speech,
  Timer,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { BuiltinPlayerState, PlayerSession, PlayerTrack, Segment } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { formatTimestamp } from '../../store/selectors';
import { languageName } from '../../services/subtitles';
import {
  autoAdvance,
  closeBuiltin,
  dismissPrompt,
  enterMini,
  noteUserActivity,
  setSleepTimer,
  stopForSleep,
  openCurrentInVlc,
  playBuiltin,
  playerCommand,
  playerSet,
  syncAudioFilters,
  toggleFullscreen,
} from '../../services/player';
import { parseMediaInfo, parseSegments } from '../../services/mediainfo';
import { cancelFrames, coarseToFine, extractFrames } from '../../services/frames';
import { getCurrentWindow } from '@tauri-apps/api/window';

const HIDE_AFTER_MS = 3000;
const NEXT_EPISODE_WINDOW_S = 30;
/** Countdown before the next episode starts once the credits begin. */
const CREDITS_COUNTDOWN_S = 10;
const THUMB_WIDTH = 320;
const MAX_THUMBS = 400;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

type Panel = 'tracks' | 'speed' | 'sleep' | null;

/** Full-window Netflix-style player chrome drawn over the native video surface. */
export default function PlayerScreen() {
  const session = useLibraryStore((s) => s.playerSession);
  const mini = useLibraryStore((s) => s.playerMini);
  useAutoAdvance(session);
  useScrubThumbnails(session);
  return <AnimatePresence>{session && !mini && <PlayerChrome key="player" session={session} />}</AnimatePresence>;
}

/** End of file: roll into the next episode, or return to the library (also in the mini-player). */
function useAutoAdvance(session: PlayerSession | null) {
  const eof = useLibraryStore((s) => !!s.playerState?.eof);
  const advancedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!session || !eof || advancedFor.current === session.target.id) return;
    advancedFor.current = session.target.id;
    if (stopForSleep()) return;
    if (session.next) autoAdvance(session.next);
    else window.setTimeout(() => void closeBuiltin(), 1200);
  }, [eof, session]);

  // Sleep timer "end of episode": stop as the credits begin rather than after them.
  const row = usePlayingRow(session);
  const creditsStart = useMemo(() => parseSegments(row?.segments).find((x) => x.kind === 'credits')?.start ?? null, [row?.segments]);
  const pastCredits = useLibraryStore((s) => creditsStart != null && !!s.playerState?.loaded && s.playerState.time >= creditsStart);
  const sleepAtEnd = useLibraryStore((s) => s.sleepTimer?.mode === 'episode');
  useEffect(() => {
    if (pastCredits && sleepAtEnd) stopForSleep();
  }, [pastCredits, sleepAtEnd]);
}

/** Library row (segments, media info, mtime) for what's playing. */
function usePlayingRow(session: PlayerSession | null) {
  return useLibraryStore((s) => {
    if (!session) return undefined;
    const { type, id } = session.target;
    return type === 'movie' ? s.movies.find((m) => m.id === id) : s.episodes.find((e) => e.id === id);
  });
}

// Scrub-bar thumbnails, generated in the background by a hidden player core.
const thumbStore = { key: '', interval: 10, frames: new Map<number, string>(), listeners: new Set<() => void>() };

function useScrubThumbnails(session: PlayerSession | null) {
  const row = usePlayingRow(session);
  const duration = useLibraryStore((s) => (s.playerState?.loaded ? s.playerState.duration : 0));
  const path = session?.target.filePath;
  const mtime = row?.file_mtime ?? 0;
  useEffect(() => {
    if (!path || !(duration > 0)) return;
    const key = `${path}|${mtime}`;
    if (thumbStore.key === key) return;
    thumbStore.key = key;
    thumbStore.frames = new Map();
    const interval = Math.max(10, duration / MAX_THUMBS);
    thumbStore.interval = interval;
    const count = Math.floor((duration - 2) / interval) + 1;
    const times = coarseToFine(count, interval, 1);
    // Give playback a head start before the second core begins decoding.
    const t = window.setTimeout(() => {
      void extractFrames({ path, mtime, times, width: THUMB_WIDTH, lane: 'scrub' }, (f) => {
        if (thumbStore.key !== key) return;
        thumbStore.frames.set(Math.round((f.time - 1) / interval), f.url);
        thumbStore.listeners.forEach((l) => l());
      }).catch(() => {});
    }, 4000);
    return () => window.clearTimeout(t);
  }, [path, mtime, duration]);
  useEffect(() => {
    if (session) return;
    thumbStore.key = '';
    thumbStore.frames = new Map();
    cancelFrames('scrub');
  }, [session]);
}

function thumbAt(time: number): string | null {
  const { frames, interval } = thumbStore;
  if (!frames.size) return null;
  const idx = Math.round(Math.max(0, time - 1) / interval);
  for (let d = 0; d < 48; d++) {
    const hit = frames.get(idx - d) ?? frames.get(idx + d);
    if (hit) return hit;
  }
  return null;
}

function useThumbVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const l = () => setV((x) => x + 1);
    thumbStore.listeners.add(l);
    return () => void thumbStore.listeners.delete(l);
  }, []);
  return v;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SkipTen({ forward }: { forward?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <g transform={forward ? 'translate(24 0) scale(-1 1)' : undefined}>
        <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
        <path d="M4 3.5v3.7h3.7" strokeLinejoin="round" />
      </g>
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.4" fontWeight="700" fill="currentColor" stroke="none" fontFamily="Helvetica Neue, Arial">
        10
      </text>
    </svg>
  );
}

function ControlButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        noteUserActivity();
        onClick();
      }}
      className={`flex h-12 w-12 items-center justify-center rounded-full text-white transition-transform duration-150 hover:scale-125 ${
        active ? 'scale-110' : ''
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Scrubber
// ---------------------------------------------------------------------------

function Scrubber({
  time,
  duration,
  onSeek,
  chapters,
}: {
  time: number;
  duration: number;
  onSeek: (t: number) => void;
  chapters: { title: string; time: number }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  useThumbVersion();

  const ratioAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const shown = drag ?? (duration ? time / duration : 0);
  const preview = drag ?? hover;
  const previewTime = preview != null ? preview * duration : 0;
  const marks = duration > 0 ? chapters.filter((c) => c.time > 1 && c.time < duration - 1) : [];
  const chapter = preview != null && chapters.length > 1 ? [...chapters].reverse().find((c) => c.time <= previewTime + 0.5) : undefined;
  const thumb = preview != null ? thumbAt(previewTime) : null;
  // Keep the preview inside the window.
  const width = ref.current?.getBoundingClientRect().width ?? 1;
  const half = (thumb ? 128 : 40) / width;
  const left = preview != null ? Math.min(1 - half, Math.max(half, preview)) : 0;

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      onPointerMove={(e) => {
        const r = ratioAt(e.clientX);
        setHover(r);
        if (drag != null) setDrag(r);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(ratioAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (drag == null) return;
        const r = ratioAt(e.clientX);
        setDrag(null);
        noteUserActivity();
        if (duration) onSeek(r * duration);
      }}
      className="group/scrub relative flex h-6 flex-1 cursor-pointer items-center"
    >
      <div className="relative h-[5px] w-full rounded-full bg-white/30 transition-[height] group-hover/scrub:h-[7px]">
        {hover != null && drag == null && (
          <div className="absolute inset-y-0 left-0 rounded-full bg-white/35" style={{ width: `${hover * 100}%` }} />
        )}
        <div className="absolute inset-y-0 left-0 rounded-full bg-nf-red" style={{ width: `${shown * 100}%` }} />
        {marks.map((c) => (
          <div key={c.time} className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-black/70" style={{ left: `${(c.time / duration) * 100}%` }} />
        ))}
        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-nf-red shadow transition-transform group-hover/scrub:scale-125"
          style={{ left: `${shown * 100}%` }}
        />
      </div>
      {preview != null && duration > 0 && (
        <div className="pointer-events-none absolute bottom-7 flex -translate-x-1/2 flex-col items-center gap-1" style={{ left: `${left * 100}%` }}>
          {thumb && (
            <img src={thumb} alt="" className="aspect-video w-64 rounded-sm bg-black object-cover shadow-2xl ring-2 ring-white/90" />
          )}
          {chapter?.title && <div className="max-w-64 truncate text-sm font-semibold text-white drop-shadow">{chapter.title}</div>}
          <div className="rounded bg-black/85 px-2 py-1 text-sm font-semibold tabular-nums text-white">{formatTimestamp(previewTime)}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

function VolumeControl({ volume, muted }: { volume: number; muted: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const setFrom = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const v = Math.round(Math.min(1, Math.max(0, (r.bottom - clientY) / r.height)) * 100);
    void playerSet('volume', v);
    if (muted && v > 0) void playerSet('mute', 'no');
  };

  const Icon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const level = muted ? 0 : volume / 100;

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => !dragging.current && setOpen(false)}>
      <ControlButton label={muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => void playerCommand('cycle', 'mute')}>
        <Icon className="h-8 w-8" />
      </ControlButton>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.12 }}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-full left-1/2 mb-1 flex h-36 w-11 -translate-x-1/2 items-center justify-center rounded bg-[#262626] py-4"
          >
            <div
              ref={ref}
              onPointerDown={(e) => {
                dragging.current = true;
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                setFrom(e.clientY);
              }}
              onPointerMove={(e) => dragging.current && setFrom(e.clientY)}
              onPointerUp={() => (dragging.current = false)}
              className="relative h-full w-2 cursor-pointer rounded-full bg-white/30"
            >
              <div className="absolute inset-x-0 bottom-0 rounded-full bg-nf-red" style={{ height: `${level * 100}%` }} />
              <div
                className="absolute left-1/2 h-4 w-4 -translate-x-1/2 translate-y-1/2 rounded-full bg-nf-red"
                style={{ bottom: `${level * 100}%` }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audio & subtitles / speed panels
// ---------------------------------------------------------------------------

const CODECS: Record<string, string> = {
  truehd: 'TrueHD',
  eac3: 'Dolby Digital+',
  ac3: 'Dolby Digital',
  dts: 'DTS',
  aac: 'AAC',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
};
const CHANNELS: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 7: '6.1', 8: '7.1' };

function trackLang(t: PlayerTrack) {
  return t.lang && t.lang !== 'und' ? languageName(t.lang) : null;
}

function audioLabel(t: PlayerTrack) {
  const lang = trackLang(t) ?? t.title ?? `Track ${t.id}`;
  const desc = t['codec-desc']?.match(/DTS-HD MA|DTS:X|DTS-HD|Atmos/i)?.[0];
  const codec = desc ?? (t.codec ? (CODECS[t.codec] ?? t.codec.toUpperCase()) : '');
  const ch = CHANNELS[t['demux-channel-count'] ?? t['audio-channels'] ?? 0] ?? '';
  return { main: lang, detail: [t.title && trackLang(t) ? t.title : '', codec, ch].filter(Boolean).join(' · ') };
}

function subLabel(t: PlayerTrack) {
  const lang = trackLang(t) ?? t.title ?? `Subtitle ${t.id}`;
  const flags = [t.forced ? 'Forced' : '', t['hearing-impaired'] ? 'SDH' : ''].filter(Boolean).join(', ');
  const detail = [t.external ? 'External file' : t.title && trackLang(t) ? t.title : '', t.codec === 'hdmv_pgs_subtitle' ? 'Image' : '']
    .filter(Boolean)
    .join(' · ');
  return { main: flags ? `${lang} (${flags})` : lang, detail };
}

function TrackRow({ selected, main, detail, onClick }: { selected: boolean; main: string; detail?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded px-3 py-2 text-left transition-colors hover:bg-white/10 ${
        selected ? 'text-white' : 'text-[#b3b3b3]'
      }`}
    >
      <Check className={`mt-0.5 h-5 w-5 shrink-0 ${selected ? 'text-white' : 'text-transparent'}`} />
      <span className="min-w-0">
        <span className={`block text-lg leading-snug ${selected ? 'font-semibold' : ''}`}>{main}</span>
        {detail && <span className="block truncate text-xs text-[#8c8c8c]">{detail}</span>}
      </span>
    </button>
  );
}

function DelayControl({ label, value, prop }: { label: string; value: number; prop: string }) {
  const step = (d: number) => void playerSet(prop, (Math.round((value + d) * 10) / 10).toFixed(1));
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-[#b3b3b3]">
      <span>{label}</span>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => step(-0.1)} className="h-7 w-9 rounded bg-white/10 font-semibold text-white hover:bg-white/20">
          −
        </button>
        <span className="w-16 text-center tabular-nums text-white">{value > 0 ? '+' : ''}{value.toFixed(1)}s</span>
        <button type="button" onClick={() => step(0.1)} className="h-7 w-9 rounded bg-white/10 font-semibold text-white hover:bg-white/20">
          +
        </button>
        {value !== 0 && (
          <button type="button" onClick={() => void playerSet(prop, '0')} className="ml-1 text-xs text-[#8c8c8c] hover:text-white">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function TracksPanel({ tracks, state }: { tracks: PlayerTrack[]; state: BuiltinPlayerState | null }) {
  const audio = tracks.filter((t) => t.type === 'audio');
  const subs = tracks.filter((t) => t.type === 'sub');
  const subsOff = !subs.some((t) => t.selected);
  return (
    <div className="w-[min(640px,90vw)] rounded-md bg-[#262626]/95 p-5 shadow-2xl backdrop-blur">
      <div className="grid grid-cols-2 gap-6">
        <div className="min-w-0">
          <h3 className="mb-2 px-3 text-2xl font-bold">Audio</h3>
          <div className="max-h-[38vh] overflow-y-auto">
            {audio.length ? (
              audio.map((t) => {
                const l = audioLabel(t);
                return <TrackRow key={t.id} selected={!!t.selected} main={l.main} detail={l.detail} onClick={() => void playerSet('aid', t.id)} />;
              })
            ) : (
              <p className="px-3 text-sm text-[#8c8c8c]">No audio tracks</p>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 px-3 text-2xl font-bold">Subtitles</h3>
          <div className="max-h-[38vh] overflow-y-auto">
            <TrackRow selected={subsOff} main="Off" onClick={() => void playerSet('sid', 'no')} />
            {subs.map((t) => {
              const l = subLabel(t);
              return <TrackRow key={t.id} selected={!!t.selected} main={l.main} detail={l.detail} onClick={() => void playerSet('sid', t.id)} />;
            })}
          </div>
        </div>
      </div>
      <AudioEnhancements />
      {state && (
        <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
          {!subsOff && <DelayControl label="Subtitle timing" value={state.sub_delay} prop="sub-delay" />}
          <DelayControl label="Audio timing" value={state.audio_delay} prop="audio-delay" />
        </div>
      )}
    </div>
  );
}

function AudioEnhancements() {
  const night = useLibraryStore((s) => s.settings.audio_night);
  const dialogue = useLibraryStore((s) => s.settings.audio_dialogue);
  const update = useLibraryStore((s) => s.updateSettings);
  const toggle = async (patch: { audio_night?: boolean; audio_dialogue?: boolean }) => {
    await update(patch);
    syncAudioFilters();
  };
  const Chip = ({ on, label, hint, icon, onClick }: { on: boolean; label: string; hint: string; icon: ReactNode; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={`flex flex-1 items-center gap-3 rounded border px-3 py-2 text-left transition-colors ${
        on ? 'border-white bg-white/15 text-white' : 'border-white/20 text-[#b3b3b3] hover:border-white/50 hover:text-white'
      }`}
    >
      {icon}
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block truncate text-xs text-[#8c8c8c]">{hint}</span>
      </span>
      <span className={`ml-auto h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${on ? 'bg-nf-red' : 'bg-white/25'}`}>
        <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
    </button>
  );
  return (
    <div className="mt-4 flex gap-3 border-t border-white/10 pt-4">
      <Chip on={dialogue} label="Dialogue boost" hint="Clearer speech" icon={<Speech className="h-5 w-5 shrink-0" />} onClick={() => void toggle({ audio_dialogue: !dialogue })} />
      <Chip on={night} label="Night mode" hint="Evens out loud and quiet" icon={<Moon className="h-5 w-5 shrink-0" />} onClick={() => void toggle({ audio_night: !night })} />
    </div>
  );
}

function SpeedPanel({ speed }: { speed: number }) {
  return (
    <div className="w-[min(560px,90vw)] rounded-md bg-[#262626]/95 px-8 pb-7 pt-5 shadow-2xl backdrop-blur">
      <h3 className="mb-6 text-2xl font-bold">Playback Speed</h3>
      <div className="relative flex justify-between">
        <div className="absolute left-3 right-3 top-[11px] h-[2px] bg-white/30" />
        {SPEEDS.map((s) => {
          const on = Math.abs(speed - s) < 0.01;
          return (
            <button key={s} type="button" onClick={() => void playerSet('speed', s)} className="relative z-10 flex flex-col items-center gap-3">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full ${on ? 'border-[5px] border-white bg-nf-red' : 'bg-[#808080] hover:bg-white'}`}
              />
              <span className={`text-sm ${on ? 'font-bold text-white' : 'text-[#b3b3b3]'}`}>{s === 1 ? '1x (Normal)' : `${s}x`}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const SLEEP_CHOICES = [15, 30, 45, 60, 90];

function SleepPanel({ isEpisode, onPick }: { isEpisode: boolean; onPick: () => void }) {
  const timer = useLibraryStore((s) => s.sleepTimer);
  const remaining = useCountdown(timer?.mode === 'minutes' ? timer.endsAt : null);
  const pick = (c: number | 'episode' | null) => {
    setSleepTimer(c);
    onPick();
  };
  const chip = (on: boolean) =>
    `rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${on ? 'border-white bg-white text-black' : 'border-white/30 text-white hover:border-white'}`;
  return (
    <div className="w-[min(520px,90vw)] rounded-md bg-[#262626]/95 p-6 shadow-2xl backdrop-blur">
      <h3 className="text-2xl font-bold">Sleep Timer</h3>
      <p className="mb-5 mt-1 text-sm text-[#b3b3b3]">
        {timer?.mode === 'minutes'
          ? `Pausing in ${formatTimestamp(remaining)}. The sound fades out first.`
          : timer?.mode === 'episode'
            ? `Stopping when this ${isEpisode ? 'episode' : 'movie'} ends.`
            : 'Fade out and pause after a while, or stop at the end.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => pick(null)} className={chip(!timer)}>
          Off
        </button>
        {SLEEP_CHOICES.map((m) => (
          <button key={m} type="button" onClick={() => pick(m)} className={chip(timer?.mode === 'minutes' && timer.minutes === m)}>
            {m} min
          </button>
        ))}
        <button type="button" onClick={() => pick('episode')} className={chip(timer?.mode === 'episode')}>
          End of {isEpisode ? 'episode' : 'movie'}
        </button>
      </div>
    </div>
  );
}

/** Seconds left until `endsAt` (updates every second). */
function useCountdown(endsAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endsAt == null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [endsAt]);
  return endsAt == null ? 0 : Math.max(0, (endsAt - now) / 1000);
}

/** "Are you still watching?" / "Sleep timer ended" over the paused video. */
function PlayerPrompt({ session }: { session: PlayerSession }) {
  const prompt = useLibraryStore((s) => s.playerPrompt);
  return (
    <AnimatePresence>
      {prompt && (
        <motion.div
          key={prompt}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-0 z-20 flex items-center bg-black/75 px-[8%]"
        >
          <div className="max-w-xl space-y-6">
            {prompt === 'still-watching' ? (
              <>
                <h2 className="text-5xl font-bold leading-tight">Are you still watching {session.title}?</h2>
                <p className="text-lg text-[#b3b3b3]">We paused so you don’t miss anything.</p>
              </>
            ) : (
              <>
                <h2 className="flex items-center gap-4 text-5xl font-bold">
                  <Moon className="h-12 w-12" /> Sleep timer ended
                </h2>
                <p className="text-lg text-[#b3b3b3]">{session.title} is paused. Good night.</p>
              </>
            )}
            <div className="flex flex-col gap-3 sm:w-72">
              <button
                type="button"
                autoFocus
                onClick={dismissPrompt}
                className="flex items-center justify-center gap-2 rounded bg-white px-6 py-3 text-lg font-semibold text-black hover:bg-white/80"
              >
                <Play className="h-5 w-5 fill-black" strokeWidth={0} />
                {prompt === 'still-watching' ? 'Continue Watching' : 'Resume'}
              </button>
              <button
                type="button"
                onClick={() => void closeBuiltin()}
                className="rounded border border-white/40 px-6 py-3 text-lg font-semibold text-white hover:border-white"
              >
                Back to Browse
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Main chrome
// ---------------------------------------------------------------------------

function PlayerChrome({ session }: { session: PlayerSession }) {
  const state = useLibraryStore((s) => s.playerState);
  const tracks = useLibraryStore((s) => s.playerTracks);
  const vlcPath = useLibraryStore((s) => s.settings.vlc_executable_path);
  const autoSkip = useLibraryStore((s) => s.settings.skip_intro_auto);
  const liveChapters = useLibraryStore((s) => s.playerChapters);
  const toast = useLibraryStore((s) => s.toast);
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const sleepTimer = useLibraryStore((s) => s.sleepTimer);
  const sleepLeft = useCountdown(sleepTimer?.mode === 'minutes' ? sleepTimer.endsAt : null);
  const row = usePlayingRow(session);
  const segments = useMemo(() => parseSegments(row?.segments), [row?.segments]);
  const chapters = useMemo(
    () => (liveChapters.length ? liveChapters : (parseMediaInfo(row?.media_info)?.chapters ?? [])),
    [liveChapters, row?.media_info],
  );
  const [visible, setVisible] = useState(true);
  const [panel, setPanel] = useState<Panel>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [pausedIdle, setPausedIdle] = useState(false);
  const [nextDismissed, setNextDismissed] = useState(false);
  const [flash, setFlash] = useState<'play' | 'pause' | null>(null);
  const hideTimer = useRef<number | null>(null);
  const overControls = useRef(false);
  const autoSkipped = useRef(new Set<string>());
  const creditsAdvanced = useRef<number | null>(null);

  const loading = !state?.loaded || state.buffering || (state.seeking && !state.paused) || (state.idle && !state.paused && !state.eof);
  const time = state?.time ?? 0;
  const duration = state?.duration ?? 0;
  const remaining = duration ? Math.max(0, duration - time) : 0;
  const isHdr = state?.gamma === 'pq' || state?.gamma === 'hlg';

  // Skip Intro / Skip Recap: shown while inside the segment (until its last second).
  const skippable: Segment | undefined = state?.loaded
    ? segments.find((x) => (x.kind === 'intro' || x.kind === 'recap') && time >= x.start && time < x.end - 1)
    : undefined;
  const skipTo = (seg: Segment) => void playerCommand('seek', Math.min(seg.end, duration - 1).toFixed(2), 'absolute');
  useEffect(() => {
    if (!autoSkip || skippable?.kind !== 'intro' || state?.paused) return;
    const key = `${session.target.id}:${skippable.start}`;
    if (autoSkipped.current.has(key)) return; // only once, so seeking back into the intro works
    autoSkipped.current.add(key);
    skipTo(skippable);
    toast('Skipped intro', 'info');
  }, [autoSkip, skippable, session.target.id]);

  // Next episode: from the start of the credits (with a countdown), else the last 30 seconds.
  const credits = segments.find((x) => x.kind === 'credits' && x.start < duration - 5);
  const nextFrom = credits ? credits.start : duration - NEXT_EPISODE_WINDOW_S;
  const nextUntil = credits ? Math.min(credits.start + CREDITS_COUNTDOWN_S, duration) : duration;
  const showNext = !!session.next && duration > 0 && time >= nextFrom && !nextDismissed && !prompt && sleepTimer?.mode !== 'episode';
  const nextProgress = showNext ? Math.min(1, Math.max(0, (time - nextFrom) / Math.max(1, nextUntil - nextFrom))) : 0;
  useEffect(() => {
    if (!showNext || !credits || state?.paused || time < nextUntil || creditsAdvanced.current === session.target.id) return;
    creditsAdvanced.current = session.target.id;
    autoAdvance(session.next!);
  }, [showNext, credits, time, nextUntil, state?.paused, session]);

  // Reset per-item UI when the next episode starts.
  useEffect(() => {
    setNextDismissed(false);
    setPanel(null);
  }, [session.target.id]);

  // Auto-hide the controls while playing.
  const poke = useCallback(() => {
    setVisible(true);
    setPausedIdle(false);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!overControls.current) setVisible(false);
    }, HIDE_AFTER_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [poke]);
  const controlsShown = visible || !!panel || !state?.loaded;

  // Netflix's "You're watching" screen after a few idle seconds paused.
  useEffect(() => {
    if (!state?.paused || panel || prompt) {
      setPausedIdle(false);
      return;
    }
    const t = window.setTimeout(() => {
      setPausedIdle(true);
      setVisible(false);
    }, 6000);
    return () => window.clearTimeout(t);
  }, [state?.paused, panel, visible, prompt]);

  // Track window fullscreen state.
  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => void win.isFullscreen().then(setFullscreen);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const togglePause = useCallback(() => {
    if (!state) return;
    setFlash(state.paused ? 'play' : 'pause');
    window.setTimeout(() => setFlash(null), 500);
    void playerCommand('cycle', 'pause');
  }, [state]);

  const seekBy = (s: number) => {
    void playerCommand('seek', s, 'relative');
    poke();
  };

  // Keyboard shortcuts (captured so they never reach the library's handlers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      noteUserActivity();
      if (useLibraryStore.getState().playerPrompt) {
        if (e.key === 'Enter' || e.key === ' ') dismissPrompt();
        else if (e.key === 'Escape') void closeBuiltin();
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      let handled = true;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          togglePause();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          seekBy(-10);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          seekBy(10);
          break;
        case 'ArrowUp':
          void playerCommand('add', 'volume', 5);
          break;
        case 'ArrowDown':
          void playerCommand('add', 'volume', -5);
          break;
        case 'm':
        case 'M':
          void playerCommand('cycle', 'mute');
          break;
        case 'f':
        case 'F':
          void toggleFullscreen().then(setFullscreen);
          break;
        case 'i':
        case 'I':
          void enterMini();
          break;
        case 's':
        case 'S':
          if (skippable) skipTo(skippable);
          else handled = false;
          break;
        case 'Escape':
          if (panel) setPanel(null);
          else if (fullscreen) void toggleFullscreen().then(setFullscreen);
          else void closeBuiltin();
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
        poke();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const title = useMemo(() => {
    const ep = session.subtitle?.match(/^S\d+:E(\d+) · (.*)$/);
    return ep ? { main: session.title, ep: `E${ep[1]}`, name: ep[2] } : { main: session.title, ep: null, name: null };
  }, [session]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      onMouseMove={poke}
      onClick={() => {
        noteUserActivity();
        if (panel) setPanel(null);
        else togglePause();
      }}
      onDoubleClick={() => void toggleFullscreen().then(setFullscreen)}
      className={`fixed inset-0 z-[200] select-none overflow-hidden text-white ${controlsShown || pausedIdle ? '' : 'cursor-none'}`}
    >
      {/* Loading / buffering */}
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-16 w-16 animate-spin rounded-full border-[5px] border-nf-red border-t-transparent" />
        </div>
      )}

      {/* Play/pause flash */}
      <AnimatePresence>
        {flash && (
          <motion.div
            key={flash}
            initial={{ opacity: 0.9, scale: 0.8 }}
            animate={{ opacity: 0, scale: 1.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-black/40">
              {flash === 'play' ? <Play className="ml-1 h-12 w-12 fill-white" strokeWidth={0} /> : <Pause className="h-12 w-12 fill-white" strokeWidth={0} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* "You're watching" (paused & idle) */}
      <AnimatePresence>
        {pausedIdle && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="pointer-events-none absolute inset-0 flex items-center bg-black/60 px-[6%]"
          >
            <div className="max-w-[45%] space-y-3">
              <div className="text-lg text-[#b3b3b3]">You’re watching</div>
              {session.logo ? (
                <img src={session.logo} alt={session.title} className="max-h-28 max-w-full object-contain object-left" />
              ) : (
                <div className="text-5xl font-black">{session.title}</div>
              )}
              {title.ep && (
                <div className="text-2xl font-bold">
                  {session.subtitle?.split(' · ')[0].replace(':', ' ')}: “{title.name}”
                </div>
              )}
              {session.overview && <p className="line-clamp-4 text-lg leading-snug text-[#d2d2d2]">{session.overview}</p>}
            </div>
            <div className="absolute bottom-[8%] right-[6%] text-xl font-semibold text-[#b3b3b3]">Paused</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chrome */}
      <motion.div
        animate={{ opacity: controlsShown ? 1 : 0 }}
        transition={{ duration: controlsShown ? 0.15 : 0.5 }}
        className={`absolute inset-0 ${controlsShown ? '' : 'pointer-events-none'}`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/80 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

        {/* Top bar */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-6 pt-5">
          <ControlButton label="Back to browse (Esc)" onClick={() => void closeBuiltin()}>
            <ArrowLeft className="h-9 w-9" />
          </ControlButton>
          <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
            {sleepTimer && (
              <button
                type="button"
                onClick={() => setPanel('sleep')}
                title="Sleep timer"
                className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1 text-xs font-semibold tabular-nums text-white/90"
              >
                <Timer className="h-3.5 w-3.5" />
                {sleepTimer.mode === 'minutes' ? `Sleep in ${formatTimestamp(sleepLeft)}` : `Stopping after this ${session.target.type === 'episode' ? 'episode' : 'movie'}`}
              </button>
            )}
            {isHdr && (
              <span className="rounded-[3px] border border-white/50 px-1.5 py-[1px] text-xs font-semibold tracking-wide">HDR</span>
            )}
            {vlcPath && (
              <button
                type="button"
                onClick={() => void openCurrentInVlc()}
                title="Continue in VLC (for files the built-in player struggles with)"
                className="rounded border border-white/30 px-3 py-1.5 text-xs font-semibold text-white/80 transition-colors hover:border-white hover:text-white"
              >
                Open in VLC
              </button>
            )}
          </div>
        </div>

        {/* Bottom controls */}
        <div
          className="absolute inset-x-0 bottom-0 px-6 pb-5"
          onMouseEnter={() => (overControls.current = true)}
          onMouseLeave={() => (overControls.current = false)}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-4">
            <Scrubber time={time} duration={duration} chapters={chapters} onSeek={(t) => void playerCommand('seek', t.toFixed(2), 'absolute')} />
            <span className="w-20 text-right text-lg tabular-nums text-white/90">{state?.duration ? formatTimestamp(remaining) : '--:--'}</span>
          </div>

          <div className="flex items-center">
            <div className="flex items-center gap-4">
              <ControlButton label={state?.paused ? 'Play (Space)' : 'Pause (Space)'} onClick={togglePause}>
                {state?.paused ? <Play className="h-9 w-9 fill-white" strokeWidth={0} /> : <Pause className="h-9 w-9 fill-white" strokeWidth={0} />}
              </ControlButton>
              <ControlButton label="Back 10 seconds (←)" onClick={() => seekBy(-10)}>
                <span className="h-9 w-9"><SkipTen /></span>
              </ControlButton>
              <ControlButton label="Forward 10 seconds (→)" onClick={() => seekBy(10)}>
                <span className="h-9 w-9"><SkipTen forward /></span>
              </ControlButton>
              <VolumeControl volume={state?.volume ?? 100} muted={!!state?.muted} />
            </div>

            <div className="min-w-0 flex-1 truncate px-6 text-center text-lg">
              <span className="font-bold">{title.main}</span>
              {title.ep && (
                <>
                  <span className="mx-2 font-bold">{title.ep}</span>
                  <span className="text-[#d2d2d2]">{title.name}</span>
                </>
              )}
            </div>

            <div className="relative flex items-center gap-4">
              {session.next && (
                <ControlButton label={`Next episode: ${session.nextLabel}`} onClick={() => void playBuiltin(session.next!)}>
                  <SkipForward className="h-8 w-8 fill-white" />
                </ControlButton>
              )}
              <ControlButton label="Audio & Subtitles" onClick={() => setPanel(panel === 'tracks' ? null : 'tracks')} active={panel === 'tracks'}>
                <MessageSquareText className="h-8 w-8" />
              </ControlButton>
              <ControlButton label="Playback Speed" onClick={() => setPanel(panel === 'speed' ? null : 'speed')} active={panel === 'speed'}>
                <Gauge className="h-8 w-8" />
              </ControlButton>
              <ControlButton label="Sleep timer" onClick={() => setPanel(panel === 'sleep' ? null : 'sleep')} active={panel === 'sleep'}>
                <Timer className={`h-8 w-8 ${sleepTimer ? 'text-nf-red' : ''}`} />
              </ControlButton>
              <ControlButton label="Mini player (I) — keep browsing while you watch" onClick={() => void enterMini()}>
                <PictureInPicture2 className="h-8 w-8" />
              </ControlButton>
              <ControlButton label={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'} onClick={() => void toggleFullscreen().then(setFullscreen)}>
                {fullscreen ? <Minimize className="h-8 w-8" /> : <Maximize className="h-8 w-8" />}
              </ControlButton>

              <AnimatePresence>
                {panel && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    transition={{ duration: 0.15 }}
                    className="absolute bottom-full right-0 mb-3"
                  >
                    {panel === 'tracks' ? (
                      <TracksPanel tracks={tracks} state={state} />
                    ) : panel === 'sleep' ? (
                      <SleepPanel isEpisode={session.target.type === 'episode'} onPick={() => setPanel(null)} />
                    ) : (
                      <SpeedPanel speed={state?.speed ?? 1} />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </motion.div>

      <PlayerPrompt session={session} />

      {/* Skip Intro / Skip Recap */}
      <AnimatePresence>
        {skippable && !showNext && !panel && !prompt && (
          <motion.button
            key={skippable.kind}
            type="button"
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 30 }}
            onClick={(e) => {
              e.stopPropagation();
              skipTo(skippable);
            }}
            className={`absolute right-8 border-2 border-white/80 bg-black/40 px-7 py-3 text-lg font-semibold text-white backdrop-blur-sm transition-[bottom,background-color] hover:bg-white hover:text-black ${
              controlsShown ? 'bottom-36' : 'bottom-12'
            }`}
          >
            {skippable.kind === 'intro' ? 'Skip Intro' : 'Skip Recap'}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Next episode */}
      <AnimatePresence>
        {showNext && (
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 30 }}
            className={`absolute right-8 flex items-center gap-3 transition-[bottom] ${controlsShown ? 'bottom-36' : 'bottom-12'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setNextDismissed(true)}
              className="rounded bg-[rgba(109,109,110,0.7)] px-5 py-3 text-lg font-semibold text-white hover:bg-[rgba(109,109,110,0.4)]"
            >
              Watch Credits
            </button>
            <button
              type="button"
              onClick={() => {
                noteUserActivity();
                void playBuiltin(session.next!);
              }}
              className="relative overflow-hidden rounded bg-white/40 px-6 py-3 text-lg font-semibold text-black"
            >
              <span
                className="absolute inset-y-0 left-0 bg-white transition-[width] duration-200 ease-linear"
                style={{ width: `${nextProgress * 100}%` }}
              />
              <span className="relative flex items-center gap-2">
                <Play className="h-5 w-5 fill-black" strokeWidth={0} /> Next Episode
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
