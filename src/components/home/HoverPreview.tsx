import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Clock, HardDriveDownload, Play, Plus, Wrench } from 'lucide-react';
import { useLibraryStore, type HoverState } from '../../store/useLibraryStore';
import { formatRuntime, genreBuckets, playTargetFor } from '../../store/selectors';
import type { MediaItem } from '../../types/media';
import { extractFrames } from '../../services/frames';
import { parseMediaInfo } from '../../services/mediainfo';
import { formatExpiryRemaining, formatSpeed, keepStreamPermanently, torrentForItem } from '../../services/torrents';
import MaturityRating from '../common/MaturityRating';
import CriticScores from '../common/CriticScores';
import { playItem } from '../../services/player';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import ProgressBar from '../common/ProgressBar';
import TechBadges from '../common/TechBadges';
import ImdbRating from '../common/ImdbRating';
import { CardTitleOverlay } from './MediaCard';

const SCALE = 1.35;
const STILL_POINTS = [0.14, 0.28, 0.42, 0.56, 0.7];
const STILL_DELAY_MS = 700;
const STILL_INTERVAL_MS = 1700;

/** Frames from the actual file (the episode you'd play next, for shows), cycled like a preview. */
function useStills(item: MediaItem) {
  const enabled = useLibraryStore((s) => s.settings.hover_stills);
  // A string so the selector result is stable between renders.
  const source = useLibraryStore((s) => {
    const target = playTargetFor(item, s.episodesBySeries);
    if (!target) return '';
    const row = target.type === 'movie' ? s.movies.find((m) => m.id === target.id) : s.episodes.find((e) => e.id === target.id);
    if (!row) return '';
    const duration = parseMediaInfo(row.media_info)?.duration || row.duration_seconds || (row.runtime ?? 0) * 60;
    return duration > 60 ? JSON.stringify([row.file_path, row.file_mtime, duration]) : '';
  });
  const [frames, setFrames] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [path, mtime, duration] = source ? (JSON.parse(source) as [string, number, number]) : [null, 0, 0];

  useEffect(() => {
    if (!enabled || !path) return;
    let alive = true;
    const t = window.setTimeout(() => {
      const times = STILL_POINTS.map((p) => Math.round(duration * p));
      void extractFrames({ path, mtime, times, width: 640, lane: 'stills' }, (f) => {
        if (alive) setFrames((prev) => (prev.includes(f.url) ? prev : [...prev, f.url]));
      }).catch(() => {});
    }, STILL_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [enabled, path, mtime, duration]);

  useEffect(() => {
    if (frames.length < 1) return;
    const t = window.setInterval(() => setIndex((i) => i + 1), STILL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [frames.length]);

  return frames.length ? frames[index % frames.length] : null;
}
const EDGE = 0.04; // matches the rows' 4% gutters

/**
 * The expanded Netflix hover card. Rendered once at the app root (fixed position) so it is
 * never clipped by the carousel's overflow, and positioned over the hovered card's rect.
 */
export default function HoverPreview() {
  const hover = useLibraryStore((s) => s.hover);
  const setHover = useLibraryStore((s) => s.setHover);

  useEffect(() => {
    if (!hover) return;
    const close = () => setHover(null);
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    document.documentElement.addEventListener('mouseleave', close);
    return () => {
      window.removeEventListener('scroll', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
      document.documentElement.removeEventListener('mouseleave', close);
    };
  }, [hover, setHover]);

  // The hover snapshot is passed as a prop so the card can finish its exit animation after
  // the store has already cleared `hover`.
  return <AnimatePresence>{hover && <PreviewCard key={hover.item.key + hover.rect.left} hover={hover} />}</AnimatePresence>;
}

function PreviewCard({ hover }: { hover: HoverState }) {
  const setHover = useLibraryStore((s) => s.setHover);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const openFixMatch = useLibraryStore((s) => s.openFixMatch);
  const toggleMyList = useLibraryStore((s) => s.toggleMyList);
  const liveItem = useLibraryStore((s) => s.items.find((i) => i.key === hover.item.key));
  const item = liveItem ?? hover.item;
  const torrent = useLibraryStore((s) => torrentForItem(item, s.torrents));
  const isDownloading = Boolean(torrent && !torrent.finished);
  const expiry = torrent?.mode === 'stream' ? formatExpiryRemaining(torrent.expiresAt, false) : null;
  const { rect } = hover;

  const layout = useMemo(() => {
    const vw = window.innerWidth;
    const width = rect.width * SCALE;
    const imgH = (width * 9) / 16;
    let left = rect.left - (width - rect.width) / 2;
    let originX = 'center';
    if (rect.left < vw * EDGE + 8) {
      left = rect.left;
      originX = 'left';
    } else if (rect.left + rect.width > vw * (1 - EDGE) - 8) {
      left = rect.left + rect.width - width;
      originX = 'right';
    }
    const top = Math.max(72, rect.top - (imgH - rect.height) / 2);
    return { width, left, top, origin: `${originX} ${rect.top - top + rect.height / 2}px` };
  }, [rect]);

  const still = useStills(item);
  const genres = genreBuckets(item.genres).slice(0, 3);
  const meta =
    item.kind === 'movie'
      ? formatRuntime(item.runtime)
      : item.seasonCount > 1
        ? `${item.seasonCount} Seasons`
        : `${item.episodeCount} Episode${item.episodeCount === 1 ? '' : 's'}`;

  return (
    <motion.div
      onMouseLeave={() => setHover(null)}
      initial={{ scale: 1 / SCALE, opacity: 0.4 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 1 / SCALE, opacity: 0, transition: { duration: 0.18 } }}
      transition={{ duration: 0.26, ease: [0.21, 0, 0.27, 1] }}
      style={{ position: 'fixed', top: layout.top, left: layout.left, width: layout.width, transformOrigin: layout.origin }}
      className="z-40 overflow-hidden rounded-md bg-nf-surface shadow-card"
    >
      <div className="relative aspect-video w-full cursor-pointer" onClick={() => openDetail(item.key)}>
        <Artwork
          src={resize(item.backdrop, 'w780')}
          alt={item.title}
          fallbackTitle={item.title}
          className={`h-full w-full ${isDownloading ? 'opacity-50 grayscale' : ''}`}
          eager
        />
        <AnimatePresence>
          {still && !isDownloading && (
            <motion.img
              key={still}
              src={still}
              alt=""
              initial={{ opacity: 0, scale: 1 }}
              animate={{ opacity: 1, scale: 1.06 }}
              exit={{ opacity: 0 }}
              transition={{ opacity: { duration: 0.6 }, scale: { duration: STILL_INTERVAL_MS / 1000 + 0.6, ease: 'linear' } }}
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
        </AnimatePresence>
        <CardTitleOverlay item={item} />
        {expiry && (
          <span
            className={`absolute right-2 top-2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold shadow backdrop-blur-xs ${
              expiry.urgent ? 'bg-nf-red/90 text-white' : 'bg-black/80 text-amber-200 ring-1 ring-amber-300/35'
            }`}
          >
            <Clock className="h-3 w-3" /> {expiry.label}
          </span>
        )}
        {isDownloading && torrent ? (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/80">
            <div
              className="h-full bg-sky-400 transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(4, torrent.progressPct))}%` }}
            />
          </div>
        ) : (
          hover.progress != null && (
            <div className="absolute inset-x-0 bottom-0">
              <ProgressBar value={hover.progress} height={3} />
            </div>
          )
        )}
      </div>

      <div className="space-y-2.5 bg-nf-surface p-[5%] pt-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => playItem(item)}
            title={isDownloading ? 'Stream Now' : 'Play'}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/80"
          >
            <Play className="ml-0.5 h-4 w-4 fill-black" strokeWidth={0} />
          </button>
          <button onClick={() => toggleMyList(item)} title={item.myList ? 'Remove from My List' : 'Add to My List'} className="nf-circle-btn h-9 w-9">
            {item.myList ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </button>
          <button onClick={() => openFixMatch(item.key)} title="Fix Match" className="nf-circle-btn h-9 w-9">
            <Wrench className="h-3.5 w-3.5" />
          </button>
          {torrent?.mode === 'stream' && (
            <button
              onClick={() => void keepStreamPermanently(torrent.infoHash)}
              title="Keep permanently in library"
              className="nf-circle-btn h-9 w-9 text-amber-200 hover:!border-amber-300"
            >
              <HardDriveDownload className="h-4 w-4" />
            </button>
          )}
          <button onClick={() => openDetail(item.key)} title="More info" className="nf-circle-btn ml-auto h-9 w-9">
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>

        {isDownloading && torrent && (
          <div className="truncate text-xs font-medium text-sky-300">
            Downloading {torrent.progressPct.toFixed(1)}%
            {torrent.downloadSpeedBps > 0 ? ` · ↓ ${formatSpeed(torrent.downloadSpeedBps)}` : ''}
          </div>
        )}

        {hover.subtitle && <div className="truncate text-xs font-semibold text-white">{hover.subtitle}</div>}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
          <ImdbRating rating={item.imdbRating} />
          <CriticScores rt={item.rtScore} metacritic={item.metacritic} />
          <MaturityRating rating={item.certification} />
          {meta && <span className="text-nf-secondary">{meta}</span>}
          <TechBadges tech={item.tech} showAudio={false} />
        </div>

        {genres.length > 0 && (
          <div className="flex flex-wrap items-center text-xs text-white">
            {genres.map((g, i) => (
              <span key={g} className="flex items-center">
                {i > 0 && <span className="mx-1.5 text-[8px] text-[#646464]">●</span>}
                {g}
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
