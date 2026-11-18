import { useLayoutEffect } from 'react';
import { formatTime } from '../library';
import { ListMusic, MessageSquareQuote, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react';
import { next, previous, seek, setBarHidden, setFull, setPanel, toggle, toggleMute, useMusicPlayer } from '../player';
import { Cover, RoundButton, useSeekDrag, VolumeSlider } from './ui';

/** Space the bar takes at the bottom of the window; pages, toasts and the cast bar keep clear of it. */
export const MUSIC_BAR_INSET = '5.75rem';

/** Sets `--tf-music-bar` on the page while the bar shows. */
function useBottomInset(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.style.setProperty('--tf-music-bar', MUSIC_BAR_INSET);
    return () => {
      root.style.removeProperty('--tf-music-bar');
    };
  }, [active]);
}

/**
 * The seek bar along the bottom of the bar. It thickens and shows a knob under the pointer, and
 * shows the time while dragging. Only this re-renders as the song plays.
 */
function Progress({ seekable }: { seekable: boolean }) {
  const time = useMusicPlayer((s) => s.time);
  const duration = useMusicPlayer((s) => s.duration || s.track?.duration || 0);
  const { drag, track, handlers } = useSeekDrag(duration, seek);
  const shown = drag ?? time;
  const pct = duration ? Math.min(100, (shown / duration) * 100) : 0;
  if (!seekable) {
    return (
      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/10">
        <div className="h-full bg-white/70" style={{ width: `${pct}%` }} />
      </div>
    );
  }
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
      {...handlers}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        seek(Math.min(duration, Math.max(0, time + (e.key === 'ArrowRight' ? 5 : -5))));
      }}
      className="group/seek absolute inset-x-3 bottom-0 h-4 cursor-pointer touch-none select-none outline-none"
    >
      <div className={`absolute inset-x-0 bottom-1.5 rounded-full bg-white/15 transition-[height] duration-150 group-hover/seek:h-1.5 ${drag != null ? 'h-1.5' : 'h-1'}`}>
        <div className="h-full rounded-full bg-white/80" style={{ width: `${pct}%` }} />
        <div
          className={`pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-opacity group-hover/seek:opacity-100 ${drag != null ? 'opacity-100' : 'opacity-0'}`}
          style={{ left: `${pct}%` }}
        />
      </div>
      {drag != null && (
        <div className="pointer-events-none absolute bottom-4 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white" style={{ left: `${pct}%` }}>
          {formatTime(drag)}
        </div>
      )}
    </div>
  );
}

/**
 * The persistent "now playing" bar at the bottom. Tap the song to open the full player; the ×
 * closes the bar while the music keeps playing (it comes back with the next song you pick).
 * `compact` is the phone layout (art, title, play/next).
 */
export default function MiniBar({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  const track = useMusicPlayer((s) => s.track);
  const playing = useMusicPlayer((s) => s.playing);
  const muted = useMusicPlayer((s) => s.muted);
  const full = useMusicPlayer((s) => s.full);
  const hidden = useMusicPlayer((s) => s.barHidden);
  const visible = !!track && !full && !hidden;
  useBottomInset(visible && !compact);
  if (!visible) return null;
  const open = (panel?: 'lyrics' | 'queue' | null) => {
    if (panel !== undefined) setPanel(panel);
    setFull(true);
  };

  return (
    // Under dialogs and Settings (z-60 and up), over the page, the navbar and hover cards.
    <div data-music-bar="" className={`pointer-events-none fixed inset-x-0 bottom-0 z-[55] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] ${className}`}>
      <div className={`pointer-events-auto relative mx-auto flex max-w-5xl items-center gap-3 overflow-hidden rounded-2xl ${compact ? 'h-16' : 'h-[4.5rem] pb-2'} border border-white/10 bg-[#2a2a2c]/95 pl-2 pr-2 shadow-[0_10px_40px_rgba(0,0,0,0.6)] sm:pr-3`}>
        <Progress seekable={!compact} />
        <button type="button" onClick={() => open(compact ? null : undefined)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Now playing: ${track.title} by ${track.artist}. Open the player`}>
          <Cover art={track.art} className="h-12 w-12 shrink-0 shadow-md" rounded="rounded-lg" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">{track.title}</div>
            <div className="truncate text-[13px] text-white/55">{track.artist}</div>
          </div>
        </button>
        {!compact && (
          <RoundButton label="Previous" onClick={previous} className="h-10 w-10 shrink-0 text-white hover:bg-white/10">
            <SkipBack className="h-5 w-5 fill-current" />
          </RoundButton>
        )}
        <RoundButton label={playing ? 'Pause' : 'Play'} onClick={toggle} className="h-11 w-11 shrink-0 text-white hover:bg-white/10">
          {playing ? <Pause className="h-7 w-7 fill-current" strokeWidth={0} /> : <Play className="ml-0.5 h-7 w-7 fill-current" strokeWidth={0} />}
        </RoundButton>
        <RoundButton label="Next" onClick={next} className="h-10 w-10 shrink-0 text-white hover:bg-white/10">
          <SkipForward className="h-5 w-5 fill-current" />
        </RoundButton>
        {!compact && (
          <>
            <div className="ml-2 hidden items-center gap-2 text-white/60 md:flex">
              <button type="button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} className="hover:text-white">
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>
              <VolumeSlider className="w-24" />
            </div>
            <RoundButton label="Lyrics" onClick={() => open('lyrics')} className="hidden h-9 w-9 shrink-0 text-white/70 hover:bg-white/10 hover:text-white sm:flex">
              <MessageSquareQuote className="h-4 w-4" />
            </RoundButton>
            <RoundButton label="Playing Next" onClick={() => open('queue')} className="hidden h-9 w-9 shrink-0 text-white/70 hover:bg-white/10 hover:text-white sm:flex">
              <ListMusic className="h-4 w-4" />
            </RoundButton>
          </>
        )}
        <RoundButton
          label={playing ? 'Close player (music keeps playing)' : 'Close player'}
          onClick={() => setBarHidden(true)}
          className="h-8 w-8 shrink-0 text-white/50 hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </RoundButton>
      </div>
    </div>
  );
}
