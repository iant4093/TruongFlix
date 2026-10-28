import { useCallback } from 'react';
import { Clock } from 'lucide-react';
import type { MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { formatExpiryRemaining, torrentForItem } from '../../services/torrents';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import { useHoverIntent } from './MediaCard';
import { Slider, useItemsPerRow } from './MediaRow';

/** Giant outlined rank numeral, drawn as SVG so it scales crisply with the row. */
function RankNumber({ rank }: { rank: number }) {
  const label = String(rank);
  return (
    <svg viewBox="0 0 100 150" preserveAspectRatio="xMaxYMax meet" className="h-full w-full" aria-hidden>
      <text
        x="100"
        y="141"
        textAnchor="end"
        fontSize="166"
        fontWeight={900}
        fontFamily="'Arial Black', 'Helvetica Neue', Arial, sans-serif"
        letterSpacing="-12"
        fill="#141414"
        stroke="#595959"
        strokeWidth="4"
        paintOrder="stroke"
        {...(label.length > 1 ? { textLength: 108, lengthAdjust: 'spacingAndGlyphs' } : {})}
      >
        {label}
      </text>
    </svg>
  );
}

function Top10Card({ item, rank }: { item: MediaItem; rank: number }) {
  const openDetail = useLibraryStore((s) => s.openDetail);
  const torrent = useLibraryStore((s) => torrentForItem(item, s.torrents));
  const build = useCallback(() => ({ item }), [item]);
  const hover = useHoverIntent(build);
  const isDownloading = Boolean(torrent && !torrent.finished);
  const expiry = torrent?.mode === 'stream' ? formatExpiryRemaining(torrent.expiresAt, true) : null;
  const pct = torrent ? Math.min(100, Math.max(torrent.state === 'resolving' ? 4 : 0, torrent.progressPct)) : 0;

  return (
    <div
      ref={hover.ref}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      onClick={() => openDetail(item.key)}
      className="relative flex aspect-[1.42] w-full cursor-pointer items-stretch"
    >
      <div className="relative z-0 w-1/2">
        <RankNumber rank={rank} />
      </div>
      <div className="relative z-10 -ml-[4%] w-1/2 overflow-hidden rounded-sm shadow-[0_0_8px_rgba(0,0,0,0.6)]">
        <Artwork
          src={resize(item.poster, 'w342')}
          alt={item.title}
          fallbackTitle={item.title}
          className={`h-full w-full ${isDownloading ? 'opacity-45 grayscale' : ''}`}
        />
        {expiry && (
          <span className="absolute right-1 top-1 inline-flex items-center gap-0.5 rounded bg-black/80 px-1 py-0.5 text-[9px] font-semibold tabular-nums text-amber-200 ring-1 ring-amber-300/35">
            <Clock className="h-2.5 w-2.5" /> {expiry.label}
          </span>
        )}
        {isDownloading && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/80">
            <div className="h-full bg-sky-400 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

interface Props {
  title: string;
  items: MediaItem[];
}

export default function Top10Row({ title, items }: Props) {
  const perPage = useItemsPerRow();
  const top = items.slice(0, 10);
  if (!top.length) return null;
  return (
    <Slider
      title={title}
      count={top.length}
      perPage={Math.max(2, perPage - 1)}
      itemKey={(i) => top[i].key}
      renderItem={(i) => <Top10Card item={top[i]} rank={i + 1} />}
    />
  );
}
