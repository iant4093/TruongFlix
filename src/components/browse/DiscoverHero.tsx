import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { SearchResult } from '../../services/tmdb';
import { useLibraryStore } from '../../store/useLibraryStore';
import { BillboardMedia, TrailerControl } from '../home/BannerTrailer';
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
    <section aria-label="Featured titles" className="nf-billboard">
      <FeaturedSlide key={`${item.kind}:${item.id}`} item={item} label={label} blocked={blocked}
        multiple={count > 1} rotating={rotating} move={move} onSelect={onSelect} />
      {count > 1 && (
        <div className="nf-billboard-controls bottom-[calc(32%+3.5rem)] right-[4%] gap-2" role="group" aria-label="Featured title controls">
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
      <BillboardMedia title={item.title} backdrop={item.backdrop} trailer={trailer} />
      <div ref={titleActions} className="nf-billboard-copy">
        <p className="text-shadow text-sm font-semibold uppercase tracking-[0.2em] text-white/75">{label}</p>
        <h1 className="nf-billboard-title line-clamp-2 break-words">{item.title}</h1>
        {!trailer.active && item.overview && <p className="nf-billboard-overview">{item.overview}</p>}
        <div className="mt-1">
          <button className="nf-btn-play text-lg" onClick={() => onSelect(item)}>View title <ArrowRight className="h-6 w-6" /></button>
        </div>
      </div>
      <div ref={trailerActions} className="nf-billboard-controls right-[4%]">
        <TrailerControl trailer={trailer} />
      </div>
    </>
  );
}
