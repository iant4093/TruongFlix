import { useState } from 'react';
import { motion } from 'framer-motion';
import { Info, Play } from 'lucide-react';
import type { MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { matchPercent, playTargetFor } from '../../store/selectors';
import { playItem } from '../../services/player';
import TechBadges from '../common/TechBadges';
import ImdbRating from '../common/ImdbRating';

interface Props {
  item: MediaItem;
}

export default function HeroBillboard({ item }: Props) {
  const openDetail = useLibraryStore((s) => s.openDetail);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const [logoFailed, setLogoFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const match = matchPercent(item.voteAverage);
  const target = playTargetFor(item, episodesBySeries);
  const resume = !!target && target.startTime > 0;

  return (
    <section className="relative h-[85vh] min-h-[520px] w-full overflow-hidden">
      {item.backdrop && (
        <motion.img
          key={item.backdrop}
          src={item.backdrop}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: loaded ? 1 : 0, scale: loaded ? 1 : 1.04 }}
          transition={{ duration: 1.1, ease: 'easeOut' }}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      )}

      {/* Left text-protection vignette */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(77deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 85%)' }}
      />
      {/* Bottom fade into the rows */}
      <div
        className="absolute inset-x-0 bottom-0 h-[45%]"
        style={{ background: 'linear-gradient(180deg, rgba(20,20,20,0) 0%, rgba(20,20,20,0.6) 60%, #141414 100%)' }}
      />

      <motion.div
        key={item.key}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.2 }}
        className="absolute bottom-[28%] left-[4%] z-10 flex max-w-[40%] flex-col gap-4"
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
          <h1 className="text-shadow text-[clamp(2.2rem,4.6vw,4.5rem)] font-black uppercase leading-[0.95] tracking-tight">
            {item.title}
          </h1>
        )}

        <div className="text-shadow flex flex-wrap items-center gap-x-3 gap-y-1 text-[clamp(0.85rem,1.1vw,1.05rem)] font-medium">
          {match != null && <span className="font-semibold text-nf-green">{match}% Match</span>}
          <ImdbRating rating={item.imdbRating} size="md" />
          {item.year && <span className="text-[#e5e5e5]">{item.year}</span>}
          {item.kind === 'tv' && item.seasonCount > 0 && (
            <span className="text-[#e5e5e5]">
              {item.seasonCount} Season{item.seasonCount > 1 ? 's' : ''}
            </span>
          )}
          <TechBadges tech={item.tech} showCodec={false} size="md" />
        </div>

        {item.overview && (
          <p className="text-shadow line-clamp-3 text-lg leading-snug text-white drop-shadow-lg">{item.overview}</p>
        )}

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
    </section>
  );
}
