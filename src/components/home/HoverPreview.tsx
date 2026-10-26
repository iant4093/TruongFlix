import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Play, Plus, Wrench } from 'lucide-react';
import { useLibraryStore, type HoverState } from '../../store/useLibraryStore';
import { formatRuntime, genreBuckets, matchPercent } from '../../store/selectors';
import { playItem } from '../../services/player';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import ProgressBar from '../common/ProgressBar';
import TechBadges from '../common/TechBadges';
import ImdbRating from '../common/ImdbRating';
import { CardTitleOverlay } from './MediaCard';

const SCALE = 1.35;
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
    window.addEventListener('resize', close);
    document.documentElement.addEventListener('mouseleave', close);
    return () => {
      window.removeEventListener('scroll', close);
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

  const match = matchPercent(item.voteAverage);
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
        <Artwork src={resize(item.backdrop, 'w780')} alt={item.title} fallbackTitle={item.title} className="h-full w-full" eager />
        <CardTitleOverlay item={item} />
        {hover.progress != null && (
          <div className="absolute inset-x-0 bottom-0">
            <ProgressBar value={hover.progress} height={3} />
          </div>
        )}
      </div>

      <div className="space-y-2.5 bg-nf-surface p-[5%] pt-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => playItem(item)}
            title="Play"
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
          <button onClick={() => openDetail(item.key)} title="More info" className="nf-circle-btn ml-auto h-9 w-9">
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>

        {hover.subtitle && <div className="truncate text-xs font-semibold text-white">{hover.subtitle}</div>}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
          {match != null && <span className="font-semibold text-nf-green">{match}% Match</span>}
          <ImdbRating rating={item.imdbRating} />
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
