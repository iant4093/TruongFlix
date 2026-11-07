import { memo, useEffect, useState } from 'react';
import { Bookmark, Download, Play, Star } from 'lucide-react';
import { getCatalogDetail, type SearchResult } from '../../services/tmdb';
import type { BrowseEpisodeSelection, CatalogDetail } from '../../types/browse';
import type { MediaItem, TorrentMode } from '../../types/media';
import { formatRuntime } from '../../store/selectors';
import useCatalogRatings from '../../hooks/useCatalogRatings';
import Artwork, { FadeImage } from '../common/Artwork';
import ImdbRating from '../common/ImdbRating';
import CriticScores from '../common/CriticScores';
import MaturityRating from '../common/MaturityRating';
import { GenreDots, HoverButton, HoverCardFrame, HoverCardLayer, HoverTitleOverlay, MoreInfoButton, useHoverCard, type HoverRect } from '../common/HoverCard';

/** Title details for a hovered catalog card (cached by the TMDB service). */
function useCatalogDetail(item: SearchResult) {
  const [state, setState] = useState<{ key: string; detail: CatalogDetail | null } | null>(null);
  const key = `${item.kind}:${item.id}`;
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => getCatalogDetail(item)).then((d) => d ?? null, () => null)
      .then((d) => { if (active) setState({ key, detail: d }); });
    return () => { active = false; };
  }, [item, key]);
  const current = state?.key === key ? state : null;
  return { detail: current?.detail ?? null, settled: !!current };
}

export interface CatalogCardActions {
  onOpen: (item: SearchResult, selection?: BrowseEpisodeSelection) => void;
  /** Opens the title and starts its quick stream or download. */
  onQuick: (item: SearchResult, mode: TorrentMode) => void;
  onPlay: (owned: MediaItem) => void;
  onToggleSave?: (item: SearchResult) => void;
}

/** A Browse poster with its caption, and the shared hover card with quick actions. */
export default memo(function CatalogCard({ item, selection, owned, inLibrary, meta, resume, saved, actions }: {
  item: SearchResult;
  selection?: BrowseEpisodeSelection;
  owned?: MediaItem;
  inLibrary: boolean;
  meta: string;
  /** Library title ready to play (saved view), with whether it resumes. */
  resume?: 'Play' | 'Resume';
  saved: boolean;
  actions: CatalogCardActions;
}) {
  const { rect, close, trigger } = useHoverCard();
  return (
    <div className="min-w-0">
      <button type="button" onClick={() => { close(); actions.onOpen(item, selection); }} onFocus={trigger.onFocus} onBlur={trigger.onBlur}
        data-tv-card-host="" className="group w-full min-w-0 text-left" aria-label={`View ${item.title}`}>
        <div
          ref={trigger.ref}
          onMouseEnter={trigger.onMouseEnter}
          onMouseMove={trigger.onMouseMove}
          onMouseLeave={trigger.onMouseLeave}
          data-tv-card=""
          className="relative aspect-[2/3] overflow-hidden rounded-md bg-[#232323] ring-white/70 group-focus-visible:ring-2"
        >
          <Artwork key={item.poster} src={item.poster} alt={item.title} fallbackTitle={item.title} className="h-full w-full" />
          {inLibrary && <span className="absolute bottom-2 left-2 rounded bg-black/85 px-2 py-1 text-[10px] font-semibold">In your library</span>}
        </div>
        <h3 className="mt-3 truncate text-sm font-semibold">{item.title}</h3>
        <p className="mt-1 text-xs text-white/60">{meta}</p>
      </button>
      {resume && owned && <button type="button" className="mt-2 inline-flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs font-medium hover:bg-white/20"
        aria-label={`${resume} ${item.title}`} onClick={() => actions.onPlay(owned)}><Play aria-hidden="true" className="h-3 w-3 fill-current" />{resume}</button>}
      <HoverCardLayer rect={rect}>
        {(r) => <CatalogHoverCard item={item} selection={selection} owned={owned} resume={resume} saved={saved} rect={r} onClose={close} actions={actions} />}
      </HoverCardLayer>
    </div>
  );
});

function CatalogHoverCard({ item, selection, owned, resume, saved, rect, onClose, actions }: {
  item: SearchResult;
  selection?: BrowseEpisodeSelection;
  owned?: MediaItem;
  resume?: 'Play' | 'Resume';
  saved: boolean;
  rect: HoverRect;
  onClose: () => void;
  actions: CatalogCardActions;
}) {
  const { detail, settled } = useCatalogDetail(item);
  const ratings = useCatalogRatings(detail?.imdbId, owned);
  const [logoFailed, setLogoFailed] = useState(false);
  const run = (action: () => void) => () => { onClose(); action(); };
  const open = run(() => actions.onOpen(item, selection));
  const tmdbRating = detail?.voteAverage ?? item.voteAverage;
  const length = detail?.kind === 'tv'
    ? detail.seasons.length ? `${detail.seasons.length} Season${detail.seasons.length === 1 ? '' : 's'}` : ''
    : formatRuntime(detail?.runtime ?? null);
  const backdrop = detail?.backdrop || item.backdrop;

  return (
    <HoverCardFrame
      rect={rect}
      onClose={onClose}
      onMediaClick={open}
      media={<>
        <Artwork key={backdrop ?? item.poster} src={backdrop ?? item.poster} alt={item.title} fallbackTitle={item.title} className="h-full w-full" eager />
        {backdrop && (
          <HoverTitleOverlay title={item.title}>
            {detail?.logo && !logoFailed
              ? <FadeImage src={detail.logo} alt="" eager fit="contain" onError={() => setLogoFailed(true)} className="max-h-[55%] max-w-[60%] object-left-bottom drop-shadow-[0_1px_4px_rgba(0,0,0,0.7)]" />
              : undefined}
          </HoverTitleOverlay>
        )}
      </>}
      actions={<>
        {owned && resume ? (
          <HoverButton primary label={`${resume} ${item.title}`} onClick={run(() => actions.onPlay(owned))}>
            <Play className="ml-0.5 h-4 w-4 fill-black" strokeWidth={0} />
          </HoverButton>
        ) : (
          <>
            <HoverButton primary label={`Stream ${item.title}`} onClick={run(() => actions.onQuick(item, 'stream'))}>
              <Play className="ml-0.5 h-4 w-4 fill-black" strokeWidth={0} />
            </HoverButton>
            <HoverButton label={`Download ${item.title}`} onClick={run(() => actions.onQuick(item, 'download'))}>
              <Download className="h-4 w-4" />
            </HoverButton>
          </>
        )}
        {actions.onToggleSave && (
          <HoverButton label={saved ? 'Remove from Saved in Browse' : 'Save to Browse'} pressed={saved} onClick={() => actions.onToggleSave?.(detail ?? item)}>
            <Bookmark className={`h-4 w-4 ${saved ? 'fill-current' : ''}`} />
          </HoverButton>
        )}
        <MoreInfoButton onClick={open} />
      </>}
    >
      {selection && <div className="truncate text-xs font-semibold text-white">Season {selection.season} · Episode {selection.episode}</div>}
      <div className="flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
        <ImdbRating rating={ratings.imdbRating} />
        {ratings.imdbRating == null && tmdbRating > 0 && (
          <span className="inline-flex items-center gap-1 text-white"><Star className="h-3 w-3 fill-current text-amber-300" />{tmdbRating.toFixed(1)}</span>
        )}
        <CriticScores rt={ratings.rtScore} metacritic={ratings.metacritic} />
        {(detail?.year ?? item.year) && <span className="text-nf-secondary">{detail?.year ?? item.year}</span>}
        <MaturityRating rating={detail?.certification || null} />
        {length && <span className="text-nf-secondary">{length}</span>}
      </div>
      {settled ? <GenreDots genres={detail?.genres.slice(0, 3) ?? []} /> : <div aria-hidden="true" className="h-4 w-32 animate-pulse rounded-sm bg-white/10" />}
    </HoverCardFrame>
  );
}
