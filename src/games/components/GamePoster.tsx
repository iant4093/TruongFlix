import { AlertTriangle, ChevronDown, Download, Loader2, Play } from 'lucide-react';
import { Slider, useItemsPerRow } from '../../components/home/MediaRow';
import { launchGame } from '../jobs';
import type { GameCard } from '../types';
import { toastError, useOwnedGame } from './actions';
import ProgressBar from '../../components/common/ProgressBar';
import GameCover from './GameCover';
import { formatPlayTime, gameProgress, gameStatusLabel, isInstalled } from './status';

/** Portrait box art with the same hover lift, badges and progress bar as the app's media cards. */
export function GamePoster({ game, onOpen, caption = false }: { game: GameCard; onOpen: (game: GameCard) => void; caption?: boolean }) {
  const { owned, job, running, torrent } = useOwnedGame(game.slug);
  const installed = !!owned && isInstalled(owned) && !job;
  const progress = owned ? gameProgress(owned, job, torrent) : null;
  const downloading = owned?.status === 'downloading' && !job;
  const busy = !!job || downloading;
  const failed = !!owned && !job && (owned.status === 'install_failed' || owned.status === 'verify_failed');
  const status = owned ? (running ? 'Playing now' : gameStatusLabel(owned, job, torrent)) : null;
  const detailLine = installed && owned ? (owned.lastPlayed ? formatPlayTime(owned.playSeconds) : 'Installed') : status ?? game.subtitle;

  return (
    <div className="min-w-0">
      <div className="group relative z-0 transition-transform duration-300 ease-out hover:z-10 hover:scale-[1.04] focus-within:z-10 focus-within:scale-[1.04]">
        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-sm bg-[#232323] shadow-[0_0_8px_rgba(0,0,0,0.6)] ring-white/70 transition-shadow duration-300 group-hover:shadow-card group-focus-within:ring-2">
          <button type="button" onClick={() => onOpen(game)} aria-label={`View ${game.title}${status ? ` — ${status}` : ''}`}
            className="absolute inset-0 z-10 rounded-sm focus-visible:outline-none" />
          <GameCover url={game.cover} title={game.title} className={`h-full w-full transition-all duration-300 ${busy ? 'opacity-45 grayscale' : ''}`} />
          {busy && <div className="pointer-events-none absolute inset-0 bg-black/30" />}

          <div className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-end bg-gradient-to-t from-black via-black/60 to-transparent p-[8%] opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
            <div className="mb-2 flex items-center gap-1.5">
              {installed && owned && !running && (
                <button type="button" aria-label={`Play ${game.title}`} disabled={!owned.exePath}
                  onClick={() => void launchGame(owned.id).catch(toastError)}
                  className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/80 disabled:opacity-50">
                  <Play className="ml-0.5 h-4 w-4 fill-black" strokeWidth={0} />
                </button>
              )}
              <button type="button" aria-label={`More info about ${game.title}`} onClick={() => onOpen(game)} tabIndex={-1}
                className="nf-circle-btn pointer-events-auto ml-auto h-8 w-8">
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
            <p className="line-clamp-2 text-[clamp(0.75rem,0.95vw,0.95rem)] font-bold leading-tight">{game.title}</p>
            {detailLine && <p className="mt-1 truncate text-[11px] text-nf-secondary">{detailLine}</p>}
          </div>

          {busy && owned && (
            <span className={`absolute left-1.5 top-1.5 z-20 inline-flex max-w-[calc(100%-12px)] items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ring-1 ring-white/15 backdrop-blur-xs ${job ? 'text-white' : 'text-nf-download-text'}`}>
              {job ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" /> : <Download className="h-2.5 w-2.5 shrink-0" />}
              <span className="truncate">{status}</span>
            </span>
          )}
          {running && <span className="absolute left-1.5 top-1.5 z-20 rounded-sm bg-nf-green px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide text-black">Playing</span>}
          {failed && (
            <span className="absolute left-1.5 top-1.5 z-20 inline-flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-300/35">
              <AlertTriangle className="h-2.5 w-2.5" />{status}
            </span>
          )}
          {owned?.status === 'downloaded' && !job && (
            <span className="absolute bottom-0 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-t-sm bg-nf-red px-2 py-[2px] text-[10px] font-bold leading-tight text-white shadow">Ready to install</span>
          )}
          {caption && installed && !running && (
            <span className="absolute bottom-2 left-2 z-20 rounded bg-black/85 px-2 py-1 text-[10px] font-semibold">In your library</span>
          )}

          {progress != null && (
            <ProgressBar value={progress / 100} min={0.03} size="regular" tone={job ? 'red' : 'download'} track="overlay" animated className="pointer-events-none absolute inset-x-0 bottom-0 z-20" />
          )}
        </div>
      </div>
      {caption && (
        <>
          <h3 className="mt-3 truncate text-sm font-semibold">{game.title}</h3>
          {game.subtitle && <p className="mt-1 truncate text-xs text-white/60">{game.subtitle}</p>}
        </>
      )}
    </div>
  );
}

const usePosterCount = () => {
  const n = useItemsPerRow();
  return n + (n >= 4 ? 2 : 1);
};

/** A Netflix row of portrait posters, using the app's paging slider. */
export function GameRow({ title, games, onOpen }: { title: string; games: GameCard[]; onOpen: (game: GameCard) => void }) {
  const perPage = usePosterCount();
  if (!games.length) return null;
  return (
    <Slider
      title={title}
      count={games.length}
      perPage={perPage}
      itemKey={(i) => games[i].slug}
      renderItem={(i) => <div className="py-2"><GamePoster game={games[i]} onOpen={onOpen} /></div>}
    />
  );
}

export const POSTER_GRID = 'grid grid-cols-3 gap-x-4 gap-y-7 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7';

export function GameGrid({ games, onOpen }: { games: GameCard[]; onOpen: (game: GameCard) => void }) {
  return <div className={POSTER_GRID}>{games.map((g) => <GamePoster key={g.slug} game={g} onOpen={onOpen} caption />)}</div>;
}

export function GameRowSkeleton() {
  const perPage = usePosterCount();
  return (
    <section aria-hidden="true" className="my-[3vw] first:mt-0">
      <div className="mx-[4%] mb-2 h-[clamp(0.95rem,1.4vw,1.5rem)] w-48 animate-pulse rounded-sm bg-[#2a2a2a]" />
      <div className="flex overflow-hidden px-[4%] py-2">
        {Array.from({ length: perPage }, (_, i) => (
          <div key={i} className="shrink-0 px-[0.2vw]" style={{ width: `${100 / perPage}%` }}>
            <div className="aspect-[2/3] w-full animate-pulse rounded-sm bg-[#232323]" style={{ animationDelay: `${i * 80}ms` }} />
          </div>
        ))}
      </div>
    </section>
  );
}
