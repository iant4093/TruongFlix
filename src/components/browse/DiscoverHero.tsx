import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { SearchResult } from '../../services/tmdb';
import { useLibraryStore } from '../../store/useLibraryStore';
import Artwork from '../common/Artwork';
import { TrailerControl, TrailerLayer } from '../home/BannerTrailer';
import { useBannerTrailer, useBannerVisibility } from '../home/useBannerTrailer';

const ARTWORK_DURATION = 12_000;
const TRAILER_LOAD_LIMIT = 45_000;
const navButton = 'flex h-9 w-9 items-center justify-center rounded-full border border-white/40 bg-black/35 hover:bg-white/15';

export default function DiscoverHero({ titles, label, blocked, onSelect }: {
  titles: SearchResult[];
  label: string;
  blocked: boolean;
  onSelect: (item: SearchResult) => void;
}) {
  const [index, setIndex] = useState(0);
  const [rotation, setRotation] = useState<boolean | null>(null);
  const reducedMotion = useReducedMotion();
  const rotating = rotation ?? !reducedMotion;
  const count = titles.length;
  const position = index % count;
  const item = titles[position];
  const move = useCallback((step: number) => setIndex((i) => (i + step + count) % count), [count]);

  return (
    <section aria-label="Featured titles" className="relative flex min-h-[clamp(300px,48vh,550px)] items-end overflow-hidden px-[4%] pb-10 pt-8">
      <FeaturedSlide key={`${item.kind}:${item.id}`} item={item} label={label} blocked={blocked}
        multiple={count > 1} rotating={rotating} move={move} onSelect={onSelect} />
      {count > 1 && (
        <div className="absolute bottom-10 right-[4%] flex items-center gap-2" role="group" aria-label="Featured title controls">
          <button className={navButton} aria-label={rotating ? 'Pause title rotation' : 'Resume title rotation'} onClick={() => setRotation(!rotating)}>
            {rotating ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button className={navButton} aria-label="Previous featured title" onClick={() => move(-1)}><ChevronLeft className="h-4 w-4" /></button>
          <span className="w-9 text-center text-xs tabular-nums text-white/75">{position + 1} / {count}</span>
          <button className={navButton} aria-label="Next featured title" onClick={() => move(1)}><ChevronRight className="h-4 w-4" /></button>
        </div>
      )}
    </section>
  );
}

function FeaturedSlide({ item, label, blocked, multiple, rotating, move, onSelect }: {
  item: SearchResult;
  label: string;
  blocked: boolean;
  multiple: boolean;
  rotating: boolean;
  move: (step: number) => void;
  onSelect: (item: SearchResult) => void;
}) {
  const titleActions = useRef<HTMLDivElement>(null);
  const trailerActions = useRef<HTMLDivElement>(null);
  const enabled = useLibraryStore((s) => s.settings.trailers_autoplay);
  const visible = useBannerVisibility(blocked);
  const trailer = useBannerTrailer({ key: `${item.kind}:${item.id}`, kind: item.kind, tmdbId: item.id, trailerKey: null }, enabled, visible);

  useEffect(() => {
    if (!visible || !rotating || !multiple || (enabled && trailer.phase === 'playing')) return;
    // Give the trailer time to start. Leave its artwork up briefly after playback ends or fails.
    const delay = enabled && trailer.phase === 'loading' ? TRAILER_LOAD_LIMIT : ARTWORK_DURATION;
    const timer = window.setInterval(() => {
      const focus = document.activeElement;
      if (!titleActions.current?.contains(focus) && !trailerActions.current?.contains(focus)) move(1);
    }, delay);
    return () => window.clearInterval(timer);
  }, [move, multiple, visible, rotating, enabled, trailer.phase]);

  return (
    <>
      <Artwork src={item.backdrop} alt="" eager className="absolute inset-0 h-full w-full object-top" />
      <TrailerLayer title={item.title} trailer={trailer} />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/85 via-black/30 to-transparent" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-nf-bg via-transparent to-transparent" />
      <div ref={titleActions} className={`relative min-w-0 max-w-2xl ${multiple ? 'mr-48' : 'mr-14'}`}>
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-white/65">{label}</p>
        <h1 className="line-clamp-2 text-4xl font-bold leading-tight md:text-[clamp(2.25rem,4vw,3.75rem)]">{item.title}</h1>
        {!trailer.active && item.overview && <p className="mt-4 line-clamp-2 max-w-xl text-base text-white/80">{item.overview}</p>}
        <button className="nf-btn-play mt-5" onClick={() => onSelect(item)}>View title <ArrowRight className="h-5 w-5" /></button>
      </div>
      <div ref={trailerActions} className={`absolute right-[4%] ${multiple ? 'bottom-24' : 'bottom-10'}`}>
        <TrailerControl trailer={trailer} />
      </div>
    </>
  );
}
