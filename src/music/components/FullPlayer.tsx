import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useDragControls, useReducedMotion } from 'framer-motion';
import { ChevronDown, Heart, ListMusic, MessageSquareQuote, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { cycleRepeat, next, previous, seek, setFull, setPanel, toggle, toggleFavourite, toggleMute, toggleShuffle, useMusicPlayer } from '../player';
import { musicToast } from '../nav';
import Lyrics from './Lyrics';
import QueuePanel from './QueuePanel';
import TrackMenu from './TrackMenu';
import { Cover, RoundButton, Scrubber, VolumeSlider } from './ui';

/** Wide enough for artwork and lyrics side by side. */
function useWide() {
  const query = '(min-width: 900px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** Blurred, slowly drifting copies of the artwork: the colours of the album fill the screen. */
function Backdrop({ url }: { url: string | null }) {
  return (
    <div className="tfm-bg" aria-hidden>
      {url ? (
        <>
          <img src={url} alt="" />
          <img src={url} alt="" />
          <img src={url} alt="" />
        </>
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#5b2333] via-[#2a2440] to-[#13243b]" />
      )}
    </div>
  );
}

export default function FullPlayer() {
  const full = useMusicPlayer((s) => s.full);
  const track = useMusicPlayer((s) => s.track);
  return <AnimatePresence>{full && track && <Sheet key="music-full" />}</AnimatePresence>;
}

function Sheet() {
  const track = useMusicPlayer((s) => s.track)!;
  const playing = useMusicPlayer((s) => s.playing);
  const loading = useMusicPlayer((s) => s.loading);
  const time = useMusicPlayer((s) => s.time);
  const duration = useMusicPlayer((s) => s.duration || s.track?.duration || 0);
  const panel = useMusicPlayer((s) => s.panel);
  const queue = useMusicPlayer((s) => s.queue);
  const muted = useMusicPlayer((s) => s.muted);
  const volume = useMusicPlayer((s) => s.volume);
  const artUrl = useMusicPlayer((s) => s.api?.artUrl(track.art) ?? null);
  const error = useMusicPlayer((s) => s.error);
  const reduce = useReducedMotion() ?? false;
  const wide = useWide();
  const drag = useDragControls();

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setFull(false);
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowRight' && e.altKey) next();
      else if (e.key === 'ArrowLeft' && e.altKey) previous();
    };
    window.addEventListener('keydown', key, true);
    const prevOverflow = document.documentElement.style.overflowY;
    document.documentElement.style.overflowY = 'hidden';
    return () => {
      window.removeEventListener('keydown', key, true);
      document.documentElement.style.overflowY = prevOverflow;
    };
  }, []);

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const fav = () => void toggleFavourite(track).catch((e) => musicToast(String(e)));
  const showPanel = panel != null;

  const controls = (big: boolean) => (
    <div className={`flex items-center justify-between ${big ? 'px-1' : ''}`}>
      <RoundButton label="Shuffle" active={queue.shuffle} onClick={toggleShuffle} className={`h-10 w-10 ${queue.shuffle ? 'bg-white/20 text-white' : 'text-white/55 hover:text-white'}`}>
        <Shuffle className="h-5 w-5" />
      </RoundButton>
      <RoundButton label="Previous" onClick={previous} className={`${big ? 'h-16 w-16' : 'h-12 w-12'} text-white hover:bg-white/10`}>
        <SkipBack className={big ? 'h-9 w-9 fill-current' : 'h-7 w-7 fill-current'} />
      </RoundButton>
      <RoundButton label={playing ? 'Pause' : 'Play'} onClick={toggle} className={`${big ? 'h-20 w-20' : 'h-14 w-14'} text-white hover:bg-white/10`}>
        {playing ? <Pause className={big ? 'h-12 w-12 fill-current' : 'h-9 w-9 fill-current'} strokeWidth={0} /> : <Play className={big ? 'ml-1 h-12 w-12 fill-current' : 'ml-1 h-9 w-9 fill-current'} strokeWidth={0} />}
      </RoundButton>
      <RoundButton label="Next" onClick={next} className={`${big ? 'h-16 w-16' : 'h-12 w-12'} text-white hover:bg-white/10`}>
        <SkipForward className={big ? 'h-9 w-9 fill-current' : 'h-7 w-7 fill-current'} />
      </RoundButton>
      <RoundButton label={queue.repeat === 'one' ? 'Repeat one' : queue.repeat === 'all' ? 'Repeat all' : 'Repeat'} active={queue.repeat !== 'off'} onClick={cycleRepeat} className={`h-10 w-10 ${queue.repeat !== 'off' ? 'bg-white/20 text-white' : 'text-white/55 hover:text-white'}`}>
        {queue.repeat === 'one' ? <Repeat1 className="h-5 w-5" /> : <Repeat className="h-5 w-5" />}
      </RoundButton>
    </div>
  );

  const info = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-bold leading-tight sm:text-[1.35rem]">{track.title}</div>
        <div className="truncate text-lg text-white/60 sm:text-[1.15rem]">
          {track.artist}
          {wide && track.album ? <span className="text-white/45"> — {track.album}</span> : null}
        </div>
      </div>
      <RoundButton label={track.favourite ? 'Remove from Favourites' : 'Favourite'} active={track.favourite} onClick={fav} className="h-10 w-10 bg-white/10 text-white hover:bg-white/20">
        <Heart className={`h-5 w-5 ${track.favourite ? 'fill-[#fa2d48] text-[#fa2d48]' : ''}`} />
      </RoundButton>
      <TrackMenu tracks={[track]} className="!h-10 !w-10 bg-white/10 !text-white hover:bg-white/20" label="More options" />
    </div>
  );

  const scrubber = <Scrubber time={time} duration={duration} onSeek={seek} />;

  const volumeRow = (
    <div className="flex items-center gap-3 text-white/60">
      <button type="button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} className="shrink-0 hover:text-white">
        <VolumeIcon className="h-4 w-4" />
      </button>
      <VolumeSlider className="flex-1" />
      <Volume2 className="h-4 w-4 shrink-0" aria-hidden />
    </div>
  );

  const panelButtons = (
    <div className="flex items-center justify-center gap-10 text-white/70">
      <RoundButton label="Lyrics" active={panel === 'lyrics'} onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')} className={`h-10 w-10 ${panel === 'lyrics' ? 'bg-white/90 text-black' : 'hover:bg-white/10'}`}>
        <MessageSquareQuote className="h-5 w-5" />
      </RoundButton>
      <RoundButton label="Playing Next" active={panel === 'queue'} onClick={() => setPanel(panel === 'queue' ? null : 'queue')} className={`h-10 w-10 ${panel === 'queue' ? 'bg-white/90 text-black' : 'hover:bg-white/10'}`}>
        <ListMusic className="h-5 w-5" />
      </RoundButton>
    </div>
  );

  const artwork = (size: string) => (
    <motion.div
      animate={{ scale: playing || reduce ? 1 : 0.86 }}
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 160, damping: 20 }}
      className={`${size} shrink-0`}
      onPointerDown={(e) => !wide && drag.start(e)}
    >
      <Cover art={track.art} alt={track.album} rounded="rounded-xl" className="h-full w-full shadow-[0_24px_60px_rgba(0,0,0,0.55)]" />
    </motion.div>
  );

  const side = panel === 'lyrics' ? (
    <Lyrics trackId={track.id} duration={duration} onSeek={seek} compact={!wide} className="h-full" />
  ) : panel === 'queue' ? (
    <QueuePanel className="h-full pt-2" />
  ) : null;

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
      className={`fixed inset-0 z-[200] overflow-hidden text-white ${playing ? '' : 'tfm-paused'}`}
      initial={reduce ? { opacity: 0 } : { y: '100%' }}
      animate={reduce ? { opacity: 1 } : { y: 0 }}
      exit={reduce ? { opacity: 0 } : { y: '100%' }}
      transition={reduce ? { duration: 0.15 } : { type: 'spring', stiffness: 260, damping: 32 }}
      drag={wide ? false : 'y'}
      dragControls={drag}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 120 || info.velocity.y > 600) setFull(false);
      }}
    >
      <Backdrop url={artUrl} />
      <div className="relative flex h-full flex-col pb-[max(1rem,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex h-12 shrink-0 items-center px-4" onPointerDown={(e) => !wide && drag.start(e)}>
          <button type="button" aria-label="Close Now Playing" title="Close" onClick={() => setFull(false)} className="flex h-10 w-10 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
            <ChevronDown className="h-7 w-7" />
          </button>
          {!wide && <div className="mx-auto h-1.5 w-10 rounded-full bg-white/40" aria-hidden />}
          {!wide && <div className="w-10" />}
        </div>

        {error && <div className="mx-auto mb-2 rounded-full bg-black/40 px-4 py-1.5 text-sm text-white/85">{error}</div>}

        {wide ? (
          <div className={`mx-auto grid min-h-0 w-full max-w-[1500px] flex-1 items-center gap-[5vw] px-[5vw] ${showPanel ? 'grid-cols-[minmax(320px,0.9fr)_1.1fr]' : 'grid-cols-1 justify-items-center'}`}>
            <div className="flex w-full max-w-[min(520px,62vh)] flex-col gap-5">
              {artwork('aspect-square w-full')}
              {info}
              {scrubber}
              {controls(false)}
              {volumeRow}
              {panelButtons}
            </div>
            {showPanel && <div className="h-full min-h-0 py-6">{side}</div>}
          </div>
        ) : panel ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 px-6 pb-2" onPointerDown={(e) => drag.start(e)}>
              <Cover art={track.art} className="h-14 w-14 shrink-0 shadow-lg" rounded="rounded-md" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{track.title}</div>
                <div className="truncate text-white/60">{track.artist}</div>
              </div>
              <RoundButton label={track.favourite ? 'Remove from Favourites' : 'Favourite'} onClick={fav} className="h-9 w-9 bg-white/10">
                <Heart className={`h-4 w-4 ${track.favourite ? 'fill-[#fa2d48] text-[#fa2d48]' : ''}`} />
              </RoundButton>
            </div>
            <div className="min-h-0 flex-1">{side}</div>
            <div className="space-y-2 px-7 pt-2">
              {scrubber}
              {controls(false)}
              {panelButtons}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-between gap-4 px-7 pb-1">
            <div className="flex min-h-0 flex-1 items-center justify-center py-2">{artwork('aspect-square w-full max-w-[min(86vw,46vh)]')}</div>
            <div className="space-y-4">
              {info}
              {scrubber}
              {controls(true)}
              {volumeRow}
              {panelButtons}
            </div>
          </div>
        )}
        {loading && <div className="pointer-events-none absolute left-1/2 top-[max(1.25rem,env(safe-area-inset-top))] h-1 w-16 -translate-x-1/2 animate-pulse rounded-full bg-white/50" aria-label="Loading" />}
      </div>
    </motion.div>
  );
}
