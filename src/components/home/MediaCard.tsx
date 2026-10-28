import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Download } from 'lucide-react';
import type { ContinueEntry, MediaItem } from '../../types/media';
import { useLibraryStore, type HoverState } from '../../store/useLibraryStore';
import { airDayLabel, epLabel, formatRemaining, formatTimestamp, newEpisodeSoon } from '../../store/selectors';
import { formatEta, formatExpiryRemaining, formatSpeed, torrentForItem } from '../../services/torrents';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import ProgressBar from '../common/ProgressBar';

export const HOVER_DELAY_MS = 350;

/**
 * Netflix hover intent: only pop the preview card after the pointer rests for 350ms,
 * so quick sweeps across a row never trigger it.
 */
export function useHoverIntent(build: () => Omit<HoverState, 'rect'>) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const setHover = useLibraryStore((s) => s.setHover);

  const cancel = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const onMouseEnter = useCallback(() => {
    cancel();
    timer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.right < 0 || r.left > window.innerWidth) return;
      setHover({ ...build(), rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
    }, HOVER_DELAY_MS);
  }, [build, cancel, setHover]);

  useEffect(() => cancel, [cancel]);

  return { ref, onMouseEnter, onMouseLeave: cancel };
}

/** Small ClearLogo (or title) overlaid on 16:9 boxart, like Netflix title treatments. */
export function CardTitleOverlay({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  if (!item.backdrop) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-1/2 items-end bg-gradient-to-t from-black/60 to-transparent p-[6%]">
      {item.logo && !failed ? (
        <img
          src={item.logo}
          alt=""
          draggable={false}
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-h-[55%] max-w-[60%] object-contain object-left-bottom drop-shadow-[0_1px_4px_rgba(0,0,0,0.7)]"
        />
      ) : (
        <span className="line-clamp-2 text-[clamp(0.7rem,1vw,1rem)] font-bold uppercase leading-tight tracking-tight text-white drop-shadow">
          {item.title}
        </span>
      )}
    </div>
  );
}

interface Props {
  item: MediaItem;
  entry?: ContinueEntry;
}

/** 16:9 boxart card used in every row and grid. */
export default function MediaCard({ item, entry }: Props) {
  const openDetail = useLibraryStore((s) => s.openDetail);
  const torrent = useLibraryStore((s) => torrentForItem(item, s.torrents));
  const [, setClockTick] = useState(0);

  useEffect(() => {
    if (!torrent?.expiresAt) return;
    const id = window.setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [torrent?.expiresAt]);

  const build = useCallback(
    () => ({
      item,
      subtitle: entry?.episode ? `${epLabel(entry.episode)} “${entry.episode.title}”` : undefined,
      progress: entry?.progress,
    }),
    [item, entry],
  );
  const hover = useHoverIntent(build);

  const thumb = entry?.episode?.still_path && !item.backdrop ? entry.episode.still_path : resize(item.backdrop, 'w780');
  const isDownloading = Boolean(torrent && !torrent.finished);
  const expiry = torrent?.mode === 'stream' ? formatExpiryRemaining(torrent.expiresAt, true) : null;
  const expiryFull = torrent?.mode === 'stream' ? formatExpiryRemaining(torrent.expiresAt, false) : null;
  const pct = torrent ? Math.min(100, Math.max(torrent.state === 'resolving' ? 4 : 0, torrent.progressPct)) : 0;

  return (
    <div className="w-full">
      <div
        ref={hover.ref}
        onMouseEnter={hover.onMouseEnter}
        onMouseLeave={hover.onMouseLeave}
        onClick={() => openDetail(item.key)}
        data-torrent-downloading={isDownloading ? 'true' : undefined}
        className="relative aspect-video w-full cursor-pointer overflow-hidden rounded-sm bg-[#232323]"
      >
        <Artwork
          src={thumb}
          alt={item.title}
          fallbackTitle={item.title}
          className={`h-full w-full transition-all duration-300 ${isDownloading ? 'opacity-45 grayscale' : ''}`}
        />
        {isDownloading && <div className="pointer-events-none absolute inset-0 bg-black/30" />}
        <CardTitleOverlay item={item} />

        {!item.matched && !isDownloading && (
          <span className="absolute left-1.5 top-1.5 rounded-sm bg-nf-red/90 px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide">
            Unmatched
          </span>
        )}

        {isDownloading && torrent && (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-sky-300 ring-1 ring-white/15 backdrop-blur-xs">
            <Download className="h-2.5 w-2.5" />
            {torrent.state === 'resolving'
              ? 'Connecting…'
              : torrent.paused
                ? `Paused ${torrent.progressPct.toFixed(0)}%`
                : `${torrent.progressPct.toFixed(0)}%`}
          </span>
        )}

        {expiry && (
          <span
            title={expiryFull?.label ?? 'Stream cache expiration'}
            className={`absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums shadow backdrop-blur-xs ${
              expiry.urgent
                ? 'bg-nf-red/90 text-white ring-1 ring-white/20'
                : 'bg-black/80 text-amber-200 ring-1 ring-amber-300/35'
            }`}
          >
            <Clock className="h-2.5 w-2.5" />
            {expiry.label}
          </span>
        )}

        {isDownloading && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 bg-black/80">
            <div className="h-full bg-sky-400 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        )}

        {!isDownloading && item.kind === 'tv' && newEpisodeSoon(item.nextEpisode) && (
          <NewEpisodeBadge date={item.nextEpisode!.air_date} />
        )}
      </div>

      {entry ? (
        <div className="mt-1.5 px-0.5">
          <ProgressBar value={entry.progress} height={3} className="rounded-sm" />
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-nf-secondary">
            <span className="truncate">{entry.episode ? epLabel(entry.episode) : 'Resume'}</span>
            <span className="shrink-0 tabular-nums">
              {entry.target.startTime > 0
                ? formatRemaining(entry.remainingSeconds) || formatTimestamp(entry.target.startTime)
                : 'Next Up'}
            </span>
          </div>
        </div>
      ) : isDownloading && torrent ? (
        <div className="mt-1.5 px-0.5">
          <div className="h-[3px] w-full overflow-hidden rounded-sm bg-[#4d4d4d]">
            <div className="h-full bg-sky-400 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-nf-secondary">
            <span className="truncate text-sky-300">
              {torrent.state === 'resolving'
                ? 'Fetching metadata…'
                : torrent.paused
                  ? 'Paused'
                  : torrent.downloadSpeedBps > 0
                    ? `↓ ${formatSpeed(torrent.downloadSpeedBps)}`
                    : 'Downloading…'}
            </span>
            <span className="shrink-0 tabular-nums">
              {torrent.etaSecs != null && !torrent.paused ? formatEta(torrent.etaSecs) : `${torrent.progressPct.toFixed(0)}%`}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Netflix's red ribbon at the bottom of a card for shows with an episode airing this week. */
export function NewEpisodeBadge({ date }: { date: string }) {
  const aired = new Date(`${date}T12:00:00`).getTime() < Date.now() - 432e5;
  return (
    <span className="absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-t-sm bg-nf-red px-2 py-[2px] text-[10px] font-bold leading-tight text-white shadow">
      {aired ? 'New Episode' : `New Episode ${airDayLabel(date)}`}
    </span>
  );
}
