import { useEffect, useState } from 'react';
import { AlertTriangle, Download, Gamepad2, Loader2, Pause, Play, RotateCcw } from 'lucide-react';
import { Slider, useItemsPerRow } from '../../components/home/MediaRow';
import { pauseTorrent, resumeTorrent } from '../../services/torrents';
import { formatSpeed } from '../../lib/format';
import { launchGame, retryDownload, useGamesStore } from '../jobs';
import { fetchGame } from '../source';
import type { GameCard, GameDetail } from '../types';
import { hasInstaller, toastError, useOwnedGame } from './actions';
import type { GameOpeners } from './GameBrowse';
import { gameFacts } from './GameBillboard';
import ProgressBar from '../../components/common/ProgressBar';
import { FadeImage } from '../../components/common/Artwork';
import { RowSkeleton } from '../../components/common/Skeleton';
import { GenreDots, HoverButton, HoverCardFrame, HoverCardLayer, HoverTitleOverlay, MoreInfoButton, useHoverCard, type HoverRect } from '../../components/common/HoverCard';
import GameCover, { useCachedImage } from './GameCover';
import { formatPlayTime, gameProgress, gameStatusLabel, isInstalled } from './status';

const isDetail = (game: GameCard): game is GameDetail => 'magnet' in game && Array.isArray((game as GameDetail).screenshots);

const details = new Map<string, Promise<GameDetail | null>>();

/** Full details for a hovered game: from the card itself, the library, or fetched once per session. */
function useGameDetail(game: GameCard): GameDetail | null {
  const ownedDetail = useGamesStore((s) => s.games.find((g) => g.slug === game.slug)?.detail ?? null);
  const origin = useGamesStore((s) => s.settings.sourceUrl);
  const known = isDetail(game) ? game : ownedDetail;
  const [fetched, setFetched] = useState<GameDetail | null>(null);
  useEffect(() => {
    if (known || !origin) return;
    let active = true;
    const key = `${origin}\n${game.slug}`;
    let pending = details.get(key);
    if (!pending) {
      pending = fetchGame(origin, game.slug).catch(() => null);
      details.set(key, pending);
      void pending.then((d) => { if (!d) details.delete(key); });
    }
    void pending.then((d) => { if (active) setFetched(d); });
    return () => { active = false; };
  }, [known, origin, game.slug]);
  return known ?? (fetched?.slug === game.slug ? fetched : null);
}

type Openers = GameOpeners;

/** Portrait box art with the same badges and progress bar as the app's media cards, and the shared hover card. */
export function GamePoster({ game, openers, caption = false }: { game: GameCard; openers: Openers; caption?: boolean }) {
  const { owned, job, running, torrent } = useOwnedGame(game.slug);
  const { rect, close, trigger } = useHoverCard();
  const installed = !!owned && isInstalled(owned) && !job;
  const progress = owned ? gameProgress(owned, job, torrent) : null;
  const downloading = owned?.status === 'downloading' && !job;
  const busy = !!job || downloading;
  const failed = !!owned && !job && (owned.status === 'install_failed' || owned.status === 'verify_failed');
  const status = owned ? (running ? 'Playing now' : gameStatusLabel(owned, job, torrent)) : null;

  return (
    <div className="min-w-0">
      <div
        ref={trigger.ref}
        onMouseEnter={trigger.onMouseEnter}
        onMouseMove={trigger.onMouseMove}
        onMouseLeave={trigger.onMouseLeave}
        onFocus={trigger.onFocus}
        onBlur={trigger.onBlur}
        data-tv-card=""
        className="relative aspect-[2/3] w-full cursor-pointer overflow-hidden rounded-sm bg-[#232323]"
      >
        <button type="button" onClick={() => { close(); openers.onOpen(game); }} aria-label={`View ${game.title}${status ? ` — ${status}` : ''}`}
          className="absolute inset-0 z-10 rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white" />
        <GameCover url={game.cover} title={game.title} className={`h-full w-full transition-all duration-300 ${busy ? 'opacity-45 grayscale' : ''}`} />
        {busy && <div className="pointer-events-none absolute inset-0 bg-black/30" />}

        {busy && owned && (
          <span className={`pointer-events-none absolute left-1.5 top-1.5 z-20 inline-flex max-w-[calc(100%-12px)] items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ring-1 ring-white/15 backdrop-blur-xs ${job ? 'text-white' : 'text-nf-download-text'}`}>
            {job ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" /> : <Download className="h-2.5 w-2.5 shrink-0" />}
            <span className="truncate">{status}</span>
          </span>
        )}
        {running && <span className="pointer-events-none absolute left-1.5 top-1.5 z-20 rounded-sm bg-nf-green px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide text-black">Playing</span>}
        {failed && (
          <span className="pointer-events-none absolute left-1.5 top-1.5 z-20 inline-flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-300/35">
            <AlertTriangle className="h-2.5 w-2.5" />{status}
          </span>
        )}
        {owned?.status === 'downloaded' && !job && (
          <span className="pointer-events-none absolute bottom-0 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-t-sm bg-nf-red px-2 py-[2px] text-[10px] font-bold leading-tight text-white shadow">Ready to install</span>
        )}
        {caption && installed && !running && (
          <span className="pointer-events-none absolute bottom-2 left-2 z-20 rounded bg-black/85 px-2 py-1 text-[10px] font-semibold">In your library</span>
        )}

        {progress != null && (
          <ProgressBar value={progress / 100} min={0.03} size="regular" tone={job ? 'red' : 'download'} track="overlay" animated className="pointer-events-none absolute inset-x-0 bottom-0 z-20" />
        )}
      </div>
      {caption && (
        <>
          <h3 className="mt-3 truncate text-sm font-semibold">{game.title}</h3>
          <p className="mt-1 h-4 truncate text-xs text-white/60">{game.subtitle}</p>
        </>
      )}
      <HoverCardLayer rect={rect}>
        {(r) => <GameHoverCard game={game} rect={r} onClose={close} openers={openers} />}
      </HoverCardLayer>
    </div>
  );
}

/** The library hover card, for a game: screenshot, Play/Download/Install, More Info, then year, size and genres. */
function GameHoverCard({ game, rect, onClose, openers }: { game: GameCard; rect: HoverRect; onClose: () => void; openers: Openers }) {
  const { owned, job, running, torrent } = useOwnedGame(game.slug);
  const detail = useGameDetail(game);
  const shot = detail?.screenshots[0];
  const screenshot = useCachedImage(shot?.thumb ?? null, shot?.full);
  const cover = useCachedImage(game.cover);
  const installed = !!owned && isInstalled(owned) && !job;
  const progress = owned ? gameProgress(owned, job, torrent) : null;
  const busy = !!job || owned?.status === 'downloading';
  const status = owned ? (running ? 'Playing now' : gameStatusLabel(owned, job, torrent)) : null;
  const { year, size, genres } = gameFacts(detail);
  const open = () => { onClose(); openers.onOpen(detail ?? game); };
  const act = (action: () => unknown) => () => {
    onClose();
    void Promise.resolve().then(action).catch(toastError);
  };

  let primary;
  if (owned && job) {
    primary = <HoverButton primary label={status ?? 'Working'} disabled onClick={() => {}}><Loader2 className="h-4 w-4 animate-spin" /></HoverButton>;
  } else if (owned && installed) {
    primary = (
      <HoverButton primary label={running ? 'Playing' : `Play ${game.title}`} disabled={running || !owned.exePath} onClick={act(() => launchGame(owned.id))}>
        <Play className="ml-0.5 h-4 w-4 fill-black" strokeWidth={0} />
      </HoverButton>
    );
  } else if (owned?.status === 'downloading') {
    primary = !torrent
      ? <HoverButton primary label="Download again" onClick={act(() => retryDownload(owned.id))}><RotateCcw className="h-4 w-4" /></HoverButton>
      : torrent.paused
        ? <HoverButton primary label="Resume download" onClick={act(() => resumeTorrent(torrent.infoHash))}><Play className="ml-0.5 h-4 w-4 fill-black" strokeWidth={0} /></HoverButton>
        : <HoverButton primary label="Pause download" onClick={act(() => pauseTorrent(torrent.infoHash))}><Pause className="h-4 w-4 fill-black" strokeWidth={0} /></HoverButton>;
  } else if (owned && hasInstaller(owned)) {
    primary = <HoverButton primary label={owned.status === 'downloaded' ? 'Install' : 'Install again'} onClick={act(() => openers.onInstall(owned))}><Gamepad2 className="h-4 w-4" /></HoverButton>;
  } else if (owned?.status === 'install_failed') {
    primary = <HoverButton primary label="Download again" disabled={!owned.detail} onClick={act(() => retryDownload(owned.id))}><RotateCcw className="h-4 w-4" /></HoverButton>;
  } else if (owned) {
    primary = <HoverButton primary label={status ?? 'Working'} disabled onClick={() => {}}><Loader2 className="h-4 w-4 animate-spin" /></HoverButton>;
  } else {
    primary = (
      <HoverButton primary label={`Download ${game.title}`} disabled={!detail?.magnet} onClick={act(() => detail && openers.onDownload(detail))}>
        {detail ? <Download className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
      </HoverButton>
    );
  }

  return (
    <HoverCardFrame
      rect={rect}
      onClose={onClose}
      onMediaClick={open}
      media={<>
        {cover && <div className="absolute inset-0 opacity-60"><FadeImage src={cover} alt="" eager className="h-full w-full scale-110 blur-xl" /></div>}
        {cover && <FadeImage src={cover} alt="" eager fit="contain" className={`absolute inset-y-0 left-1/2 h-full w-auto -translate-x-1/2 ${busy ? 'opacity-50 grayscale' : ''}`} />}
        {screenshot && <FadeImage src={screenshot} alt={game.title} eager className={`absolute inset-0 h-full w-full ${busy ? 'grayscale' : ''}`} />}
        <HoverTitleOverlay title={game.title} />
        {progress != null && (
          <ProgressBar value={progress / 100} min={0.03} size="regular" tone={job ? 'red' : 'download'} track="overlay" animated className="pointer-events-none absolute inset-x-0 bottom-0" />
        )}
      </>}
      actions={<>
        {primary}
        <MoreInfoButton onClick={open} />
      </>}
    >
      {busy && status && (
        <div className={`truncate text-xs font-medium ${job ? 'text-white' : 'text-nf-download-text'}`}>
          {status}
          {!job && torrent && !torrent.paused && torrent.downloadSpeedBps > 0 ? ` · ↓ ${formatSpeed(torrent.downloadSpeedBps)}` : ''}
        </div>
      )}
      {installed && owned && <div className="truncate text-xs font-semibold text-nf-green">{owned.lastPlayed ? `Played ${formatPlayTime(owned.playSeconds)}` : 'Ready to play'}</div>}
      {game.subtitle && <div className="truncate text-xs font-semibold text-white">{game.subtitle}</div>}
      <div className="flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
        {year && <span className="text-nf-secondary">{year}</span>}
        {size && <span className="rounded-[3px] border border-white/40 px-1 py-px text-[10px] leading-none text-white/85">{size}</span>}
        {!detail && <span className="h-3 w-24 animate-pulse rounded-sm bg-white/10" aria-hidden="true" />}
      </div>
      <GenreDots genres={genres} />
    </HoverCardFrame>
  );
}

const usePosterCount = () => {
  const n = useItemsPerRow();
  return n + (n >= 4 ? 2 : 1);
};

/** A Netflix row of portrait posters, using the app's paging slider. */
export function GameRow({ title, games, openers }: { title: string; games: GameCard[]; openers: Openers }) {
  const perPage = usePosterCount();
  if (!games.length) return null;
  return (
    <Slider
      title={title}
      count={games.length}
      perPage={perPage}
      itemKey={(i) => games[i].slug}
      renderItem={(i) => <GamePoster game={games[i]} openers={openers} />}
    />
  );
}

export const POSTER_GRID = 'grid grid-cols-3 gap-x-4 gap-y-7 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7';

export function GameGrid({ games, openers }: { games: GameCard[]; openers: Openers }) {
  return <div className={POSTER_GRID}>{games.map((g) => <GamePoster key={g.slug} game={g} openers={openers} caption />)}</div>;
}

export function GameRowSkeleton() {
  return <RowSkeleton perPage={usePosterCount()} shape="portrait" />;
}
