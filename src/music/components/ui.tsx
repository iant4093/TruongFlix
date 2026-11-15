import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Music } from 'lucide-react';
import { setVolume, useMusicPlayer } from '../player';
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

export function EqBars({ playing, className = '' }: { playing: boolean; className?: string }) {
  return (
    <span className={`tfm-eq ${playing ? '' : 'tfm-eq-paused'} ${className}`} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

/** Thin progress bar that grows when touched; drag to seek. */
export function Scrubber({ time, duration, onSeek, className = '', showTimes = true, light = true }: { time: number; duration: number; onSeek: (t: number) => void; className?: string; showTimes?: boolean; light?: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? time;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  return (
    <div className={className}>
      <div className="group relative flex h-5 items-center">
        <div className={`h-1.5 w-full overflow-hidden rounded-full transition-[height] group-hover:h-2 ${light ? 'bg-white/25' : 'bg-white/15'} ${drag != null ? '!h-2.5' : ''}`}>
          <div className={`h-full rounded-full ${light ? 'bg-white/90' : 'bg-white/80'}`} style={{ width: `${pct}%` }} />
        </div>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(shown, duration || 0)}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => {
            if (drag != null) onSeek(drag);
            setDrag(null);
          }}
          onKeyUp={() => {
            if (drag != null) onSeek(drag);
            setDrag(null);
          }}
          onBlur={() => setDrag(null)}
          className="tfm-range absolute inset-0 h-full w-full opacity-0"
        />
      </div>
      {showTimes && (
        <div className="mt-1 flex justify-between text-[11px] font-medium tabular-nums text-white/55">
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
