import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Music } from 'lucide-react';
import { setScrub, setVolume, useMusicPlayer } from '../player';
import { musicLevels } from '../analyser';
import { formatTime } from '../library';
import '../music.css';

/** Album art, or a soft gradient with a note when the album has none. */
export function Cover({ art, alt = '', className = '', rounded = 'rounded-md', icon = 'h-1/3 w-1/3' }: { art: string | null | undefined; alt?: string; className?: string; rounded?: string; icon?: string }) {
  const url = useMusicPlayer((s) => s.api?.artUrl(art) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={`relative aspect-square overflow-hidden bg-gradient-to-br from-[#3a3a3c] to-[#1f1f21] ${rounded} ${className}`}>
      {url && !failed ? (
        <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-white/30">
          <Music className={icon} strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

/** 2×2 covers for a playlist (or one, or a placeholder). */
export function Mosaic({ arts, className = '' }: { arts: string[]; className?: string }) {
  if (arts.length < 4) return <Cover art={arts[0] ?? null} className={className} />;
  return (
    <div className={`grid aspect-square grid-cols-2 overflow-hidden rounded-md ${className}`}>
      {arts.slice(0, 4).map((a) => (
        <Cover key={a} art={a} rounded="" icon="h-1/2 w-1/2" />
      ))}
    </div>
  );
}

const BARS = [0, 1, 2, 3, 4];

/**
 * Five now-playing bars. On the desktop each one moves with its own slice of the music, from bass
 * to treble; without live levels (the browser app, or silence) they fall back to a gentle animation.
 */
export function EqBars({ playing, className = '' }: { playing: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!playing) return setLive(false);
    let raf = 0;
    let shown = false;
    const smooth = BARS.map(() => 0);
    // Each band's recent loudest moment (fading over a few seconds): quiet treble still moves the bar.
    const peak = BARS.map(() => 0.05);
    const tick = () => {
      const levels = musicLevels();
      if (levels && !shown) setLive((shown = true));
      if (!levels && shown) setLive((shown = false));
      const bars = ref.current?.children;
      if (levels && bars) {
        levels.forEach((v, i) => {
          peak[i] = Math.max(v, peak[i] * 0.996, 0.05);
          // Mostly relative to the band's recent peak, partly absolute; quick to rise, slower to fall.
          const target = Math.min(1, 0.65 * Math.pow(v / peak[i], 1.6) + 0.35 * Math.pow(v, 0.7));
          smooth[i] = target > smooth[i] ? target : smooth[i] * 0.86 + target * 0.14;
          (bars[i] as HTMLElement).style.height = `${Math.round(18 + smooth[i] * 82)}%`;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return (
    <span ref={ref} className={`tfm-eq ${playing && !live ? '' : 'tfm-eq-paused'} ${live ? 'tfm-eq-live' : ''} ${className}`} aria-hidden>
      {BARS.map((i) => (
        <span key={i} />
      ))}
    </span>
  );
}

/**
 * Thin progress bar that grows when touched; drag anywhere on it to seek. Pointer dragging (not a
 * hidden range input, whose tiny thumb phones can barely grab) works the same with a finger or a
 * mouse, and lyrics follow the finger while dragging. Arrow keys step 5 s.
 */
export function Scrubber({ time, duration, onSeek, className = '', showTimes = true, light = true }: { time: number; duration: number; onSeek: (t: number) => void; className?: string; showTimes?: boolean; light?: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const shown = drag ?? time;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !duration) return 0;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const move = (t: number) => {
    setDrag(t);
    setScrub(t);
  };
  const finish = (t: number | null) => {
    setScrub(null);
    setDrag(null);
    if (t != null) onSeek(t);
  };
  useEffect(() => () => setScrub(null), []);
  return (
    <div className={className}>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
        onPointerDown={(e) => {
          if (!duration || e.button > 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          move(at(e.clientX));
        }}
        onPointerMove={(e) => {
          if (drag != null) move(at(e.clientX));
        }}
        onPointerUp={(e) => {
          if (drag != null) finish(at(e.clientX));
        }}
        onPointerCancel={() => finish(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          e.stopPropagation();
          onSeek(Math.min(duration, Math.max(0, time + (e.key === 'ArrowRight' ? 5 : -5))));
        }}
        className="group relative flex h-6 cursor-pointer touch-none select-none items-center outline-none"
      >
        <div className={`h-1.5 w-full overflow-hidden rounded-full transition-[height] duration-150 group-hover:h-2 group-focus-visible:h-2 ${light ? 'bg-white/25' : 'bg-white/15'} ${drag != null ? '!h-2.5' : ''}`}>
          <div className={`h-full rounded-full ${light ? 'bg-white/90' : 'bg-white/80'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {showTimes && (
        <div className="mt-0.5 flex justify-between text-[11px] font-medium tabular-nums text-white/55">
          <span>{formatTime(shown)}</span>
          <span>-{formatTime(Math.max(0, duration - shown))}</span>
        </div>
      )}
    </div>
  );
}

export function VolumeSlider({ className = '' }: { className?: string }) {
  const volume = useMusicPlayer((s) => s.volume);
  const muted = useMusicPlayer((s) => s.muted);
  const shown = muted ? 0 : volume;
  return (
    <div className={`group relative flex h-5 items-center ${className}`}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/25">
        <div className="h-full rounded-full bg-white/90" style={{ width: `${shown * 100}%` }} />
      </div>
      <input
        type="range"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        onChange={(e) => setVolume(Number(e.target.value))}
        className="tfm-range absolute inset-0 h-full w-full opacity-0"
      />
    </div>
  );
}

export function RoundButton({ label, onClick, children, className = '', active = false, disabled = false }: { label: string; onClick: () => void; children: ReactNode; className?: string; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-center rounded-full transition active:scale-90 disabled:opacity-30 ${className}`}
    >
      {children}
    </button>
  );
}

/** Closes on outside click / Escape. */
export function useDismiss(open: boolean, close: () => void, ignore?: HTMLElement | null) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !ignore?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const id = setTimeout(() => document.addEventListener('pointerdown', down), 0);
    document.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, close, ignore]);
  return ref;
}
