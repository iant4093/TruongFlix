import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { BillboardMedia } from '../../components/home/BannerTrailer';
import type { GameDetail } from '../types';
import { useCachedImage } from './GameCover';

/** Netflix's red "TOP 10" tile, as shown beside a billboard's ranking line. */
export function Top10Badge() {
  return (
    <span aria-hidden="true" className="flex h-[1.75em] w-[1.5em] shrink-0 flex-col items-center justify-center rounded-[2px] bg-nf-red font-black leading-none text-white">
      <span className="text-[0.38em] tracking-tight">TOP</span>
      <span className="text-[0.8em] tracking-tighter">10</span>
    </span>
  );
}

/** Year, download size and genres in the billboard's metadata style. */
export function gameFacts(detail: GameDetail | null | undefined) {
  if (!detail) return { year: null, size: null, genres: [] as string[] };
  const year = detail.date ? new Date(detail.date).getFullYear() : null;
  return { year: year && Number.isFinite(year) ? year : null, size: detail.repackSize || null, genres: detail.genres.slice(0, 3) };
}

export function MetaLine({ detail, extra, genres: showGenres = true }: { detail: GameDetail | null | undefined; extra?: ReactNode; genres?: boolean }) {
  const facts = gameFacts(detail);
  const { year, size } = facts;
  const genres = showGenres ? facts.genres : [];
  if (!year && !size && !genres.length && !extra) return null;
  return (
    <div className="text-shadow flex flex-wrap items-center gap-x-3 gap-y-1 text-[clamp(0.85rem,1.1vw,1.05rem)] font-medium text-[#e5e5e5]">
      {extra}
      {year && <span>{year}</span>}
      {size && <span className="rounded-[3px] border border-white/40 px-1.5 py-px text-[0.85em] leading-tight">{size}</span>}
      {genres.length > 0 && <span>{genres.join(' • ')}</span>}
    </div>
  );
}

/** Full-bleed hero matching the Home and Movies billboard: backdrop, gradients, copy and buttons. */
export default function GameBillboard({ id, title, detail, cover, eyebrow, extra, overview, actions, controls }: {
  id: string;
  title: string;
  detail: GameDetail | null | undefined;
  cover: string | null;
  eyebrow?: ReactNode;
  extra?: ReactNode;
  overview?: string;
  actions: ReactNode;
  controls?: ReactNode;
}) {
  const shot = detail?.screenshots[0];
  const backdrop = useCachedImage(shot?.full ?? null, shot?.thumb);
  const coverSrc = useCachedImage(shot ? null : cover);
  return (
    <section aria-label={`Featured: ${title}`} className="nf-billboard">
      {coverSrc && <img src={coverSrc} alt="" draggable={false} className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl" />}
      <BillboardMedia title={title} backdrop={backdrop} />
      <motion.div
        key={id}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.2 }}
        className="nf-billboard-copy"
      >
        {eyebrow}
        <h1 className={`nf-billboard-title line-clamp-2 break-words ${title.length > 26 ? '!text-[clamp(1.8rem,3.4vw,3.4rem)]' : ''}`}>{title}</h1>
        <MetaLine detail={detail} extra={extra} />
        {overview && <p className="nf-billboard-overview">{overview}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-3">{actions}</div>
      </motion.div>
      {controls}
    </section>
  );
}

/** Placeholder shown while the featured game loads, in the billboard's exact footprint. */
export function GameBillboardSkeleton() {
  return (
    <section aria-hidden="true" className="nf-billboard bg-[radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.06),transparent_60%)]">
      <div className="nf-billboard-copy w-[40%]">
        <div className="h-[clamp(2.2rem,4.6vw,4.5rem)] w-4/5 animate-pulse rounded bg-white/10" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-white/10" />
        <div className="space-y-2">
          <div className="h-4 w-full animate-pulse rounded bg-white/[0.07]" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-white/[0.07]" />
        </div>
        <div className="mt-1 flex gap-3">
          <div className="h-12 w-40 animate-pulse rounded bg-white/15" />
          <div className="h-12 w-44 animate-pulse rounded bg-white/10" />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[45%]"
        style={{ background: 'linear-gradient(180deg, rgba(20,20,20,0) 0%, #141414 100%)' }} />
    </section>
  );
}
