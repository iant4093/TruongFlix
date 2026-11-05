import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Info, Play } from 'lucide-react';
import { useBannerTrailer, useBannerVisibility } from './useBannerTrailer';
import { BillboardMedia, TrailerControl } from './BannerTrailer';
import type { MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { playTargetFor } from '../../store/selectors';
import { playItem } from '../../services/player';
import TechBadges from '../common/TechBadges';
import ImdbRating from '../common/ImdbRating';
import CriticScores from '../common/CriticScores';

interface Props {
  item: MediaItem;
}

export default function HeroBillboard({ item }: Props) {
  const openDetail = useLibraryStore((s) => s.openDetail);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const [logoFailed, setLogoFailed] = useState(false);

  const target = playTargetFor(item, episodesBySeries);
  const resume = !!target && target.startTime > 0;

  const enabled = useLibraryStore((s) => s.settings.trailers_autoplay);
  const playing = useBannerVisibility();
  const trailer = useBannerTrailer(item, enabled, playing);

  return (
    <section className="nf-billboard">
      <BillboardMedia title={item.title} backdrop={item.backdrop} trailer={trailer} />

      <motion.div
        key={item.key}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.2 }}
        className="nf-billboard-copy"
      >
        {item.logo && !logoFailed ? (
          <img
            src={item.logo}
            alt={item.title}
            draggable={false}
            onError={() => setLogoFailed(true)}
            className="max-h-[130px] max-w-full self-start object-contain object-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]"
          />
        ) : (
          <h1 className="nf-billboard-title">
            {item.title}
          </h1>
        )}

        <div className="text-shadow flex flex-wrap items-center gap-x-3 gap-y-1 text-[clamp(0.85rem,1.1vw,1.05rem)] font-medium">
          <ImdbRating rating={item.imdbRating} size="md" />
          <CriticScores rt={item.rtScore} metacritic={item.metacritic} size="md" />
          {item.year && <span className="text-[#e5e5e5]">{item.year}</span>}
          {item.kind === 'tv' && item.seasonCount > 0 && (
            <span className="text-[#e5e5e5]">
              {item.seasonCount} Season{item.seasonCount > 1 ? 's' : ''}
            </span>
          )}
          <TechBadges tech={item.tech} showCodec={false} size="md" />
        </div>

        <AnimatePresence initial={false}>
          {item.overview && !trailer.active && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.6 }}
              className="nf-billboard-overview"
            >
              {item.overview}
            </motion.p>
          )}
        </AnimatePresence>

        <div className="mt-1 flex items-center gap-3">
          <button onClick={() => playItem(item)} className="nf-btn-play text-lg">
            <Play className="h-7 w-7 fill-black" strokeWidth={0} />
            {resume ? 'Resume' : 'Play'}
          </button>
          <button onClick={() => openDetail(item.key)} className="nf-btn-info text-lg">
            <Info className="h-7 w-7" />
            More Info
          </button>
        </div>
      </motion.div>

      {/* Right side: trailer sound / replay + maturity rating, as on Netflix */}
      <div className="nf-billboard-controls">
        <TrailerControl trailer={trailer} />
        {item.certification && (
          <div className="flex h-9 items-center border-l-[3px] border-[#dcdcdc] bg-[rgba(51,51,51,0.6)] pl-3 pr-[4vw] text-lg">
            {item.certification}
          </div>
        )}
      </div>
    </section>
  );
}
