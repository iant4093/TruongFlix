import { ListMusic, MessageSquareQuote, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { next, previous, seek, setFull, setPanel, toggle, toggleMute, useMusicPlayer } from '../player';
import { Cover, RoundButton, VolumeSlider } from './ui';

/**
 * The persistent "now playing" bar at the bottom. Tap the song to open the full player.
 * `compact` is the phone layout (art, title, play/next).
 */
export default function MiniBar({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  const track = useMusicPlayer((s) => s.track);
  const playing = useMusicPlayer((s) => s.playing);
  const time = useMusicPlayer((s) => s.time);
  const duration = useMusicPlayer((s) => s.duration || s.track?.duration || 0);
  const muted = useMusicPlayer((s) => s.muted);
  const full = useMusicPlayer((s) => s.full);
  if (!track || full) return null;
  const pct = duration ? Math.min(100, (time / duration) * 100) : 0;
  const open = (panel?: 'lyrics' | 'queue' | null) => {
    if (panel !== undefined) setPanel(panel);
    setFull(true);
  };

  return (
    <div className={`fixed inset-x-0 bottom-0 z-[120] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] ${className}`}>
      <div className="relative mx-auto flex h-16 max-w-5xl items-center gap-3 overflow-hidden rounded-2xl border border-white/10 bg-[#2a2a2c]/90 pl-2 pr-2 shadow-[0_10px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl sm:pr-3">
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/10">
          <div className="h-full bg-white/70" style={{ width: `${pct}%` }} />
        </div>
        {!compact && (
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={duration || 0}
            step={0.5}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            className="tfm-range absolute inset-x-0 bottom-0 h-2 opacity-0"
          />
        )}
        <button type="button" onClick={() => open(compact ? null : undefined)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Now playing: ${track.title} by ${track.artist}. Open the player`}>
          <Cover art={track.art} className="h-12 w-12 shrink-0 shadow-md" rounded="rounded-lg" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">{track.title}</div>
            <div className="truncate text-[13px] text-white/55">{track.artist}</div>
          </div>
        </button>
        {!compact && (
          <RoundButton label="Previous" onClick={previous} className="h-10 w-10 text-white hover:bg-white/10">
            <SkipBack className="h-5 w-5 fill-current" />
          </RoundButton>
        )}
        <RoundButton label={playing ? 'Pause' : 'Play'} onClick={toggle} className="h-11 w-11 text-white hover:bg-white/10">
          {playing ? <Pause className="h-7 w-7 fill-current" strokeWidth={0} /> : <Play className="ml-0.5 h-7 w-7 fill-current" strokeWidth={0} />}
        </RoundButton>
        <RoundButton label="Next" onClick={next} className="h-10 w-10 text-white hover:bg-white/10">
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
            <RoundButton label="Lyrics" onClick={() => open('lyrics')} className="h-9 w-9 text-white/70 hover:bg-white/10 hover:text-white">
              <MessageSquareQuote className="h-4 w-4" />
            </RoundButton>
            <RoundButton label="Playing Next" onClick={() => open('queue')} className="h-9 w-9 text-white/70 hover:bg-white/10 hover:text-white">
              <ListMusic className="h-4 w-4" />
            </RoundButton>
          </>
        )}
      </div>
    </div>
  );
}
