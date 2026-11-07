import { useState, type Ref } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Info, Play } from 'lucide-react';
import type { MediaItem } from '../../types/media';
import CriticScores from '../common/CriticScores';
import ImdbRating from '../common/ImdbRating';
import TechBadges from '../common/TechBadges';
import { useSkipEntrance } from '../../lib/sectionMemory';
import { billboardCopy } from '../../lib/motion';

type BillboardDetails = Pick<MediaItem, 'title' | 'logo' | 'year' | 'kind' | 'seasonCount' | 'overview' | 'imdbRating' | 'rtScore' | 'metacritic'>
  & Partial<Pick<MediaItem, 'tech'>>;

export default function BillboardCopy({ item, trailerActive, onInfo, play, copyRef }: {
  item: BillboardDetails;
  trailerActive: boolean;
  onInfo: () => void;
  play?: { resume: boolean; onClick: () => void };
  copyRef?: Ref<HTMLDivElement>;
}) {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const skipEntrance = useSkipEntrance();
  return (
    <motion.div
      ref={copyRef}
      variants={billboardCopy}
      initial={skipEntrance ? false : 'initial'}
      animate="animate"
      className="nf-billboard-copy"
    >
      {item.logo && item.logo !== failedLogo ? (
        <h1 className="max-w-full self-start">
          <img
            src={item.logo}
            alt={item.title}
            draggable={false}
            onError={() => setFailedLogo(item.logo)}
            className="max-h-[130px] max-w-full object-contain object-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]"
          />
        </h1>
      ) : (
        <h1 className="nf-billboard-title line-clamp-2 break-words">{item.title}</h1>
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
        {item.tech && <TechBadges tech={item.tech} showCodec={false} size="md" />}
      </div>

      <AnimatePresence initial={false}>
        {item.overview && !trailerActive && (
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
        {play && (
          <button onClick={play.onClick} data-nav-autofocus="" className="nf-btn-play text-lg">
            <Play className="h-7 w-7 fill-black" strokeWidth={0} />
            {play.resume ? 'Resume' : 'Play'}
          </button>
        )}
        <button onClick={onInfo} data-nav-autofocus={play ? undefined : ''} className="nf-btn-info text-lg">
          <Info className="h-7 w-7" />
          More Info
        </button>
      </div>
    </motion.div>
  );
}
