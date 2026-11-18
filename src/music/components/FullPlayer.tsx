import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useDragControls, useReducedMotion } from 'framer-motion';
import { AudioLines, ChevronDown, Heart, ListMusic, MessageSquareQuote, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { cycleRepeat, next, previous, seek, setFull, setPanel, toggle, toggleFavourite, toggleMute, toggleShuffle, useMusicPlayer } from '../player';
import { musicToast } from '../nav';
import { paintSoft, SOFT_SIZE } from '../softArt';
import { lockPageScroll } from '../../lib/scrollLock';
import { musicQuality } from '../library';
import type { MusicTrack } from '../types';
import Lyrics from './Lyrics';
import QueuePanel from './QueuePanel';
import TrackMenu from './TrackMenu';
import { Cover, PlayPauseIcon, RoundButton, Scrubber, VolumeSlider } from './ui';
import { errorMessage } from '../../lib/errors';

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

/**
 * The artwork shrunk to a few dozen pixels, blurred once and stretched to fill the screen. A tiny
 * canvas scaled up is as soft as a huge CSS blur but costs almost nothing per frame, so the drifting
 * colours stay smooth (a full-screen `filter: blur()` on three moving layers made the player lag).
 */
function useSoftArt(url: string | null) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImage(null);
    if (!url) return;
    let live = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => live && setImage(img);
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return image;
}

function SoftLayer({ image }: { image: HTMLImageElement }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paintSoft(ref.current, image);
  }, [image]);
  return <canvas ref={ref} width={SOFT_SIZE} height={SOFT_SIZE} />;
}

/** Blurred, slowly drifting copies of the artwork: the colours of the album fill the screen. */
function Backdrop({ url }: { url: string | null }) {
  const image = useSoftArt(url);
  // The next song's colours fade in over the last song's, which stay until they're covered.
  const [sets, setSets] = useState<{ image: HTMLImageElement; fresh: boolean }[]>([]);
  useEffect(() => {
    if (!image) return;
    // Songs from the same album share a cover: nothing to fade.
    setSets((list) => (list.at(-1)?.image.src === image.src ? list : [...list.slice(-1).map((s) => ({ ...s, fresh: false })), { image, fresh: list.length > 0 }]));
    const t = window.setTimeout(() => setSets((list) => list.filter((s) => s.image.src === image.src)), 1000);
    return () => window.clearTimeout(t);
  }, [image]);
  return (
    <div className="tfm-bg" aria-hidden>
      {sets.length ? (
        sets.map((s) => (
          <div key={s.image.src} className={`tfm-bg-set ${s.fresh ? 'tfm-bg-new' : ''}`}>
            <SoftLayer image={s.image} />
            <SoftLayer image={s.image} />
            <SoftLayer image={s.image} />
          </div>
        ))
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#5b2333] via-[#2a2440] to-[#13243b]" />
      )}
    </div>
  );
}

/** The scrubber, on its own so the rest of the player doesn't re-render as the song plays. */
function TimeScrubber() {
  const time = useMusicPlayer((s) => s.time);
  const duration = useMusicPlayer((s) => s.duration || s.track?.duration || 0);
  return <Scrubber time={time} duration={duration} onSeek={seek} />;
}

/** "Lossless" / "Hi-Res Lossless" / "AAC 256 kbps", like Apple Music's badge under the scrubber. */
function QualityBadge({ track }: { track: MusicTrack }) {
  const q = musicQuality(track);
  if (!q.label && !q.detail) return null;
  return (
    <div className="flex justify-center">
      <span
        title={q.detail || q.label}
        className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-[3px] text-[11px] font-semibold tracking-wide text-white/75"
      >
        {q.lossless && <AudioLines className="h-3.5 w-3.5" aria-hidden />}
        {q.label || q.detail}
        {q.label && q.detail && <span className="font-medium text-white/50">{q.detail}</span>}
      </span>
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
    const unlock = lockPageScroll();
    return () => {
      window.removeEventListener('keydown', key, true);
      unlock();
    };
  }, []);

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const fav = () => void toggleFavourite(track).catch((e) => musicToast(errorMessage(e)));
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
        <PlayPauseIcon playing={playing} className={big ? 'h-12 w-12' : 'h-9 w-9'} />
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
      <div key={track.id} className="tfm-fadein min-w-0 flex-1">
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

  const scrubber = (
    <div className="space-y-1.5">
      <TimeScrubber />
      <QualityBadge track={track} />
    </div>
  );

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

  // Opening lyrics or Up Next moves the artwork into place (and the panel slides in), like Apple Music.
  const layoutSpring = reduce ? { duration: 0 } : { type: 'spring' as const, stiffness: 300, damping: 34 };
  const panelIn = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : { initial: { opacity: 0, y: 28 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 28 }, transition: { duration: 0.32, ease: [0.22, 0.9, 0.28, 1] as const } };

  const artwork = (size: string) => (
    <motion.div
      layoutId="tfm-art"
      layout
      animate={{ scale: playing || reduce ? 1 : 0.86 }}
      transition={reduce ? { duration: 0 } : { scale: { type: 'spring', stiffness: 160, damping: 20 }, layout: layoutSpring }}
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

        <LayoutGroup>
        {wide ? (
          <div className={`mx-auto grid min-h-0 w-full max-w-[1500px] flex-1 items-center gap-[5vw] px-[5vw] ${showPanel ? 'grid-cols-[minmax(320px,0.9fr)_1.1fr]' : 'grid-cols-1 justify-items-center'}`}>
            {/* The artwork gets what's left after the controls, so nothing drops off the bottom of a short window. */}
            <motion.div layout="position" transition={layoutSpring} className="flex w-full max-w-[min(520px,max(340px,calc(100vh-27rem)))] flex-col gap-[min(1.25rem,2.2vh)]">
              {artwork('aspect-square w-full max-w-[min(520px,max(160px,calc(100vh-27rem)))] self-center')}
              {info}
              {scrubber}
              {controls(false)}
              {volumeRow}
              {panelButtons}
            </motion.div>
            <AnimatePresence mode="popLayout" initial={false}>
              {showPanel && (
                <motion.div key="panel" className="h-full min-h-0 py-6" {...panelIn} initial={reduce ? { opacity: 0 } : { opacity: 0, x: 60 }} animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, x: 60 }}>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div key={panel} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                      {side}
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          // Phones: one layout that changes shape. Opening lyrics or Up Next shrinks the artwork into
          // the header (title and heart fade in beside it), the panel rises in, the song details and
          // volume fold away and the controls glide down; closing it plays the same in reverse.
          <div className="flex min-h-0 flex-1 flex-col">
            {panel ? (
              <div className="flex items-center gap-3 px-6 pb-2" onPointerDown={(e) => drag.start(e)}>
                <motion.div layoutId="tfm-art" layout transition={{ layout: layoutSpring }} className="h-14 w-14 shrink-0">
                  <Cover art={track.art} className="h-full w-full shadow-lg" rounded="rounded-md" />
                </motion.div>
                <motion.div className="min-w-0 flex-1" initial={reduce ? false : { opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08, duration: 0.28 }}>
                  <div key={track.id} className="tfm-fadein">
                    <div className="truncate font-bold">{track.title}</div>
                    <div className="truncate text-white/60">{track.artist}</div>
                  </div>
                </motion.div>
                <motion.div initial={reduce ? false : { opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.12, duration: 0.25 }}>
                  <RoundButton label={track.favourite ? 'Remove from Favourites' : 'Favourite'} onClick={fav} className="h-9 w-9 bg-white/10">
                    <Heart className={`h-4 w-4 ${track.favourite ? 'fill-[#fa2d48] text-[#fa2d48]' : ''}`} />
                  </RoundButton>
                </motion.div>
              </div>
            ) : (
              /* Sized to the space it has (width and height), so it never runs into the title below. */
              <div className="flex min-h-0 flex-1 items-center justify-center px-7 py-2 [container-type:size]">{artwork('aspect-square w-[min(100cqw,100cqh)]')}</div>
            )}
            {panel && (
              <AnimatePresence mode="wait">
                <motion.div key={panel} className="min-h-0 flex-1" {...panelIn}>
                  {side}
                </motion.div>
              </AnimatePresence>
            )}
            <motion.div layout="position" transition={layoutSpring} className="px-7 pb-1 pt-2">
              <AnimatePresence initial={false}>
                {!panel && (
                  <motion.div key="info" className="overflow-hidden" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduce ? 0 : 0.28 }}>
                    <div className="pb-4">{info}</div>
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="pb-3">{scrubber}</div>
              <div className="pb-3">{controls(true)}</div>
              <AnimatePresence initial={false}>
                {!panel && (
                  <motion.div key="volume" className="overflow-hidden" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduce ? 0 : 0.28 }}>
                    <div className="pb-4">{volumeRow}</div>
                  </motion.div>
                )}
              </AnimatePresence>
              {panelButtons}
            </motion.div>
          </div>
        )}
        </LayoutGroup>
        {loading && <div className="pointer-events-none absolute left-1/2 top-[max(1.25rem,env(safe-area-inset-top))] h-1 w-16 -translate-x-1/2 animate-pulse rounded-full bg-white/50" aria-label="Loading" />}
      </div>
    </motion.div>
  );
}
