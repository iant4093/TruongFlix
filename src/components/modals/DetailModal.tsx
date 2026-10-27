import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Cast, Check, CheckCheck, ChevronRight, FolderOpen, Play, Plus, Sparkles, Trash2, Wrench, X } from 'lucide-react';
import { deleteMedia, FILE_MANAGER_NAME, revealInFileManager } from '../../services/files';
import EpisodeDetail from './EpisodeDetail';
import SubtitlesPanel from '../common/SubtitlesPanel';
import Dropdown from '../common/Dropdown';
import ImdbRating from '../common/ImdbRating';
import MaturityRating from '../common/MaturityRating';
import CriticScores from '../common/CriticScores';
import { CastLinks, StreamInfo } from '../common/StreamInfo';
import type { CollectionPart, EpisodeRow, MediaItem, PlayTarget, SeasonEpisodeInfo } from '../../types/media';
import * as db from '../../services/db';
import { setEpisodesWatched } from '../../services/db';
import { getSeasonEpisodes } from '../../services/tmdb';
import { parseMediaInfo } from '../../services/mediainfo';
import { selectItem, useLibraryStore } from '../../store/useLibraryStore';
import {
  airDayLabel,
  continueWatching,
  epLabel,
  newEpisodeSoon,
  formatRemaining,
  formatRuntime,
  genreBuckets,
  matchPercent,
  playTargetFor,
} from '../../store/selectors';
import { play, playEpisode } from '../../services/player';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import ProgressBar from '../common/ProgressBar';
import TechBadges from '../common/TechBadges';

export default function DetailModal() {
  const detailKey = useLibraryStore((s) => s.detailKey);
  const liveItem = useLibraryStore(selectItem(detailKey));
  const openDetail = useLibraryStore((s) => s.openDetail);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastItem = useRef<MediaItem | null>(null);
  if (liveItem) lastItem.current = liveItem;
  // Keep rendering the last item while the modal plays its exit animation.
  const item = liveItem ?? (detailKey ? null : lastItem.current);

  const episodeId = useLibraryStore((s) => s.detailEpisodeId);
  const openEpisode = useLibraryStore((s) => s.openEpisode);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const episodes = item?.kind === 'tv' ? (episodesBySeries.get(item.id) ?? []) : [];
  const episode = episodeId != null ? (episodes.find((e) => e.id === episodeId) ?? null) : null;

  // Selected season lives here so it survives a trip into an episode page and back.
  const [season, setSeason] = useState<number | null>(null);
  useEffect(() => setSeason(null), [item?.key]);
  useEffect(() => {
    if (episode) setSeason(episode.season_number);
  }, [episode?.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [detailKey, episodeId]);

  useEffect(() => {
    if (detailKey && !liveItem) openDetail(null);
  }, [detailKey, liveItem, openDetail]);

  useEffect(() => {
    if (episodeId != null && liveItem && !episode) openEpisode(null);
  }, [episodeId, liveItem, episode, openEpisode]);

  if (!item) return null;

  return (
    <motion.div
      ref={scrollRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onMouseDown={(e) => e.target === e.currentTarget && openDetail(null)}
      className="fixed inset-0 z-[60] flex justify-center overflow-y-auto bg-black/70 px-4 pb-10 pt-8 backdrop-blur-xs"
    >
      <motion.div
        key={item.key}
        initial={{ opacity: 0, scale: 0.94, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 30 }}
        transition={{ duration: 0.28, ease: [0.21, 0, 0.27, 1] }}
        className="relative h-max w-full max-w-4xl overflow-hidden rounded-xl bg-nf-surface shadow-2xl"
      >
        <motion.div
          key={episode ? `ep-${episode.id}` : 'series'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
        >
          {episode ? (
            <EpisodeDetail series={item} episode={episode} episodes={episodes} />
          ) : (
            <DetailContent item={item} season={season} onSeasonChange={setSeason} />
          )}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

interface ContentProps {
  item: MediaItem;
  season: number | null;
  onSeasonChange: (season: number) => void;
}

function DetailContent({ item, season, onSeasonChange }: ContentProps) {
  const openDetail = useLibraryStore((s) => s.openDetail);
  const openFixMatch = useLibraryStore((s) => s.openFixMatch);
  const toggleMyList = useLibraryStore((s) => s.toggleMyList);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const [logoFailed, setLogoFailed] = useState(false);

  const episodes = item.kind === 'tv' ? (episodesBySeries.get(item.id) ?? []) : [];
  // Version picker (movies with several files, e.g. 1080p and 4K).
  const [versionId, setVersionId] = useState(item.id);
  useEffect(() => setVersionId(item.id), [item.key, item.id]);
  const versionRow = useLibraryStore((s) => (item.kind === 'movie' ? s.movies.find((m) => m.id === versionId) : undefined));
  const target: PlayTarget | null = versionRow
    ? { type: 'movie', id: versionRow.id, filePath: versionRow.file_path, startTime: versionRow.watched ? 0 : versionRow.progress_seconds, label: item.title }
    : playTargetFor(item, episodesBySeries);
  const mediaInfo = versionRow ? parseMediaInfo(versionRow.media_info) : item.mediaInfo;
  const resumeEntry = useMemo(
    () => continueWatching([item], episodesBySeries)[0] ?? null,
    [item, episodesBySeries],
  );

  const match = matchPercent(item.voteAverage);
  const cast = item.cast.filter((c) => !c.job);
  const crew = item.cast.filter((c) => c.job);
  const genres = item.genres;

  const toast = useLibraryStore((s) => s.toast);
  const revealPath = item.kind === 'movie' ? (versionRow?.file_path ?? item.filePath) : (episodes[0]?.file_path ?? null);
  const playLabel = target && target.startTime > 0 ? 'Resume' : 'Play';
  const epHint = target?.type === 'episode' && resumeEntry?.episode ? epLabel(resumeEntry.episode) : null;

  return (
    <>
      {/* Header */}
      <div className="relative aspect-video w-full">
        <Artwork src={resize(item.backdrop, 'w1280')} alt={item.title} fallbackTitle={item.title} className="h-full w-full" eager />
        <div className="absolute inset-0 bg-gradient-to-t from-nf-surface via-nf-surface/10 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-transparent to-transparent" />

        <button
          onClick={() => openDetail(null)}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-nf-surface text-white hover:bg-[#2a2a2a]"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="absolute bottom-[8%] left-12 right-12 flex flex-col gap-5">
          {item.logo && !logoFailed ? (
            <img
              src={item.logo}
              alt={item.title}
              onError={() => setLogoFailed(true)}
              draggable={false}
              className="max-h-[110px] max-w-[45%] self-start object-contain object-left drop-shadow-[0_2px_10px_rgba(0,0,0,0.6)]"
            />
          ) : (
            <h2 className="text-shadow max-w-[70%] text-5xl font-black uppercase leading-none tracking-tight">{item.title}</h2>
          )}
          <div className="flex items-center gap-2.5">
            <button onClick={() => target && play(target)} disabled={!target} className="nf-btn-play px-8 text-lg disabled:opacity-50">
              <Play className="h-6 w-6 fill-black" strokeWidth={0} />
              {playLabel}
              {epHint && <span className="text-base font-medium text-black/60">{epHint}</span>}
            </button>
            <button
              onClick={() => toggleMyList(item)}
              title={item.myList ? 'Remove from My List' : 'Add to My List'}
              className="nf-circle-btn h-11 w-11"
            >
              {item.myList ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
            </button>
            {target && (
              <button
                onClick={() => useLibraryStore.getState().setCastPicker({ target, start: target.startTime })}
                title="Cast to a TV"
                className="nf-circle-btn h-11 w-11"
              >
                <Cast className="h-4 w-4" />
              </button>
            )}
            <button onClick={() => openFixMatch(item.key)} title="Fix Match" className="nf-circle-btn h-11 w-11">
              <Wrench className="h-4 w-4" />
            </button>
            {revealPath && (
              <button
                onClick={() => revealInFileManager(revealPath).catch((e) => toast(String(e), 'error'))}
                title={`Show in ${FILE_MANAGER_NAME}`}
                className="nf-circle-btn h-11 w-11"
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={async () => {
                if (await deleteMedia({ kind: item.kind, item })) openDetail(null);
              }}
              title={item.kind === 'tv' ? 'Delete show' : 'Delete movie'}
              className="nf-circle-btn h-11 w-11 hover:!border-nf-red hover:!bg-nf-red/20"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-[65%_35%] gap-8 px-12 pb-8 pt-2">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[15px]">
            {match != null && <span className="font-semibold text-nf-green">{match}% Match</span>}
            <ImdbRating rating={item.imdbRating} votes={item.imdbVotes} imdbId={item.imdbId} showVotes size="md" />
            <CriticScores rt={item.rtScore} metacritic={item.metacritic} size="md" />
            {item.stinger && (
              <span className="flex items-center gap-1 text-sm text-[#ffd76a]" title="TMDB lists a scene during or after the credits">
                <Sparkles className="h-4 w-4" />
                {item.stinger === 'during' ? 'Scene during the credits' : item.stinger === 'after' ? 'Scene after the credits' : 'Scenes during & after the credits'}
              </span>
            )}
            {item.year && <span className="text-nf-secondary">{item.year}</span>}
            <MaturityRating rating={item.certification} size="md" />
            {item.kind === 'movie' && item.runtime ? <span className="text-nf-secondary">{formatRuntime(item.runtime)}</span> : null}
            {item.kind === 'tv' && (
              <span className="text-nf-secondary">
                {item.seasonCount} Season{item.seasonCount === 1 ? '' : 's'}
              </span>
            )}
            <TechBadges tech={versionRow ?? item.tech} size="md" />
          </div>

          {item.versions.length > 1 && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-nf-muted">Version</span>
              <Dropdown
                value={versionId}
                options={item.versions.map((v) => ({ value: v.id, label: v.label }))}
                onChange={setVersionId}
                ariaLabel="Version"
                className="min-w-[260px]"
              />
            </div>
          )}

          {item.kind === 'tv' && item.nextEpisode && (
            <p className={`text-sm font-semibold ${newEpisodeSoon(item.nextEpisode) ? 'text-nf-red' : 'text-nf-secondary'}`}>
              {newEpisodeSoon(item.nextEpisode) ? 'New episode' : 'Next episode'} {airDayLabel(item.nextEpisode.air_date)}
              <span className="font-normal text-nf-secondary">
                {' '}
                · S{item.nextEpisode.season}:E{item.nextEpisode.episode}
                {item.nextEpisode.name && !/^Episode \d+$/.test(item.nextEpisode.name) ? ` “${item.nextEpisode.name}”` : ''}
              </span>
            </p>
          )}

          {resumeEntry && resumeEntry.target.startTime > 0 && (
            <div className="flex items-center gap-3 text-sm text-nf-secondary">
              <ProgressBar value={resumeEntry.progress} height={4} className="max-w-[220px] rounded-sm" />
              <span className="whitespace-nowrap">
                {resumeEntry.episode ? `${epLabel(resumeEntry.episode)} · ` : ''}
                {formatRemaining(resumeEntry.remainingSeconds)}
              </span>
            </div>
          )}

          {item.tagline && <p className="text-base italic text-white/70">{item.tagline}</p>}
          <p className="text-[15px] leading-relaxed text-white">{item.overview || 'No synopsis available.'}</p>

          {item.filePath && (
            <p className="selectable break-all font-mono text-[11px] text-nf-muted">File: {versionRow?.file_path ?? item.filePath}</p>
          )}
          {!item.matched && (
            <p className="text-sm text-nf-secondary">
              This file couldn’t be identified automatically.{' '}
              <button onClick={() => openFixMatch(item.key)} className="font-semibold text-white underline underline-offset-2">
                Fix Match
              </button>
            </p>
          )}
        </div>

        <div className="space-y-3 text-sm leading-relaxed">
          {cast.length > 0 && (
            <p>
              <span className="text-nf-muted">Cast: </span>
              <CastLinks people={cast} limit={4} />
            </p>
          )}
          {genres.length > 0 && (
            <p>
              <span className="text-nf-muted">Genres: </span>
              {genres.join(', ')}
            </p>
          )}
          {crew.length > 0 && (
            <p>
              <span className="text-nf-muted">{crew[0].job === 'Creator' ? 'Creator' : 'Director'}: </span>
              <CastLinks people={crew} />
            </p>
          )}
        </div>
      </div>

      {item.kind === 'tv' && (
        <EpisodeSelector item={item} episodes={episodes} season={season} onSeasonChange={onSeasonChange} />
      )}
      {item.kind === 'movie' && item.collectionId && <CollectionSection item={item} />}
      {item.kind === 'movie' && item.filePath && (
        <SubtitlesPanel
          target={{
            type: 'movie',
            id: versionRow?.id ?? item.id,
            filePath: versionRow?.file_path ?? item.filePath,
            tmdbId: item.tmdbId,
            fallbackQuery: item.rawFilename?.replace(/\.[^.]+$/, '') ?? item.title,
          }}
        />
      )}
      <MoreLikeThis item={item} />
      <About item={item} mediaInfo={mediaInfo} size={versionRow?.file_size} />
    </>
  );
}

interface SelectorProps {
  item: MediaItem;
  episodes: EpisodeRow[];
  season: number | null;
  onSeasonChange: (season: number) => void;
}

/** TMDB's episode list per season (cached in SQLite), fetched on demand for missing/upcoming episodes. */
function useSeasonList(tmdbId: number | null, season: number) {
  const [cache, setCache] = useState<Map<number, SeasonEpisodeInfo[]>>(new Map());
  const fetched = useRef(new Set<number>());
  useEffect(() => {
    if (!tmdbId) return;
    let alive = true;
    void db.getSeasonCache(tmdbId).then((rows) => {
      if (!alive) return;
      setCache(new Map(rows.map((r) => [r.season_number, JSON.parse(r.episodes) as SeasonEpisodeInfo[]])));
    });
    return () => {
      alive = false;
    };
  }, [tmdbId]);
  useEffect(() => {
    if (!tmdbId || cache.has(season) || fetched.current.has(season)) return;
    fetched.current.add(season);
    void getSeasonEpisodes(tmdbId, season)
      .then(() => db.getSeasonCache(tmdbId))
      .then((rows) => setCache(new Map(rows.map((r) => [r.season_number, JSON.parse(r.episodes) as SeasonEpisodeInfo[]]))))
      .catch(() => {});
  }, [tmdbId, season, cache]);
  return cache.get(season) ?? [];
}

function EpisodeSelector({ item, episodes, season: chosenSeason, onSeasonChange }: SelectorProps) {
  const seasons = useMemo(() => {
    const owned = new Set(episodes.map((e) => e.season_number));
    for (let n = 1; n <= item.tmdbSeasons; n++) owned.add(n);
    return [...owned].sort((a, b) => a - b);
  }, [episodes, item.tmdbSeasons]);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const openEpisode = useLibraryStore((s) => s.openEpisode);
  const imdbEnabled = useLibraryStore((s) => s.settings.imdb_enabled);
  const initialSeason = useMemo(() => {
    const t = playTargetFor(item, episodesBySeries);
    const ep = t ? episodes.find((e) => e.id === t.id) : null;
    return ep?.season_number ?? seasons.find((s) => s > 0) ?? seasons[0] ?? 1;
  }, [item.key]); // only re-derive when switching titles, not on every progress update
  const season = chosenSeason ?? initialSeason;
  const list = episodes.filter((e) => e.season_number === season);
  const tmdbList = useSeasonList(item.tmdbId, season);
  const owned = new Set(list.map((e) => e.episode_number));
  const missing = tmdbList.filter((e) => !owned.has(e.episode_number));
  const rows: ({ kind: 'owned'; ep: EpisodeRow } | { kind: 'missing'; info: SeasonEpisodeInfo })[] = [
    ...list.map((ep) => ({ kind: 'owned' as const, ep })),
    ...missing.map((info) => ({ kind: 'missing' as const, info })),
  ].sort((a, b) => (a.kind === 'owned' ? a.ep.episode_number : a.info.episode_number) - (b.kind === 'owned' ? b.ep.episode_number : b.info.episode_number));
  const seasonName = (s: number) => (s === 0 ? 'Specials' : `Season ${s}`);
  const seasonOptions = seasons.map((s) => {
    const n = episodes.filter((e) => e.season_number === s).length;
    const avg = item.imdbSeasons[s]?.rating;
    const imdbHint = avg != null && imdbEnabled ? ` · ★ ${avg.toFixed(1)}` : '';
    return { value: s, label: seasonName(s), hint: n ? `${n} Episode${n === 1 ? '' : 's'}${imdbHint}` : 'Not in your library' };
  });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="px-12 pb-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-4">
          <h3 className="text-2xl font-bold">Episodes</h3>
          <ImdbRating
            rating={item.imdbSeasons[season]?.rating}
            suffix={`${seasonName(season)} avg · ${item.imdbSeasons[season]?.count ?? 0} rated`}
            size="md"
            className="text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <WatchedMenu episodes={episodes} season={season} seasonLabel={seasonName(season)} />
          <Dropdown
            value={season}
            options={seasonOptions}
            onChange={onSeasonChange}
            size="lg"
            align="right"
            ariaLabel="Season"
            className="min-w-[160px]"
          />
        </div>
      </div>

      <div>
        {rows.map((row) => {
          if (row.kind === 'missing') {
            const info = row.info;
            const upcoming = !info.air_date || info.air_date > today;
            return (
              <div key={`missing-${info.episode_number}`} className="flex w-full items-center gap-5 border-b border-[#404040] px-6 py-6 last:border-b-0">
                <span className="w-6 shrink-0 text-center text-2xl text-[#6d6d6d]">{info.episode_number}</span>
                <div className="relative aspect-video w-[130px] shrink-0 overflow-hidden rounded bg-[#2a2a2a]">
                  {info.still_path && <Artwork src={info.still_path} alt={info.name} className="h-full w-full opacity-30 grayscale" />}
                </div>
                <div className="min-w-0 flex-1 opacity-60">
                  <div className="mb-1.5 flex items-baseline justify-between gap-4">
                    <span className="truncate font-semibold">{info.name}</span>
                    <span className="shrink-0 text-sm">{info.runtime ? `${info.runtime}m` : ''}</span>
                  </div>
                  {info.overview && <p className="line-clamp-2 text-sm leading-snug text-nf-secondary">{info.overview}</p>}
                  <div className={`mt-1.5 text-[11px] font-semibold uppercase tracking-wide ${upcoming ? 'text-nf-red' : 'text-nf-muted'}`}>
                    {upcoming ? (info.air_date ? `Coming ${airDayLabel(info.air_date)}` : 'Coming soon') : 'Not in your library'}
                  </div>
                </div>
                <span className="w-6 shrink-0" />
              </div>
            );
          }
          const ep = row.ep;
          const dur = ep.duration_seconds || (ep.runtime ?? 0) * 60;
          const progress = !ep.watched && ep.progress_seconds > 0 && dur ? ep.progress_seconds / dur : ep.watched ? 1 : 0;
          return (
            <div
              key={ep.id}
              role="button"
              tabIndex={0}
              onClick={() => openEpisode(ep.id)}
              onKeyDown={(e) => e.key === 'Enter' && openEpisode(ep.id)}
              title="Episode details"
              className="group flex w-full cursor-pointer items-center gap-5 rounded-md border-b border-[#404040] px-6 py-6 text-left transition-colors last:border-b-0 hover:bg-[#333]"
            >
              <span className="w-6 shrink-0 text-center text-2xl text-[#d2d2d2]">{ep.episode_number}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  playEpisode(ep, item);
                }}
                title={`Play ${epLabel(ep)}`}
                className="group/thumb relative aspect-video w-[130px] shrink-0 overflow-hidden rounded"
              >
                <Artwork src={ep.still_path ?? resize(item.backdrop, 'w300')} alt={ep.title} className="h-full w-full" />
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:opacity-100 group-hover/thumb:bg-black/30">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white bg-black/50 transition-transform group-hover/thumb:scale-110">
                    <Play className="ml-0.5 h-4 w-4 fill-white" strokeWidth={0} />
                  </span>
                </div>
                {progress > 0 && (
                  <div className="absolute inset-x-0 bottom-0">
                    <ProgressBar value={progress} height={3} />
                  </div>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-baseline justify-between gap-4">
                  <span className="truncate font-semibold">{ep.title}</span>
                  <span className="flex shrink-0 items-center gap-3 text-sm">
                    <ImdbRating rating={ep.imdb_rating} className="text-xs" />
                    {ep.runtime ? `${ep.runtime}m` : ''}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm leading-snug text-nf-secondary">{ep.overview || 'No description available.'}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <TechBadges tech={ep} showCodec={false} showAudio={false} />
                  {ep.watched ? <span className="text-[11px] text-nf-muted">Watched</span> : null}
                </div>
              </div>
              <ChevronRight className="h-6 w-6 shrink-0 text-white/0 transition-colors group-hover:text-white/70" />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Franchise films in release order; ones you don't have are greyed out. */
function CollectionSection({ item }: { item: MediaItem }) {
  const collection = useLibraryStore((s) => s.collections.find((c) => c.id === item.collectionId));
  const items = useLibraryStore((s) => s.items);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const parts = useMemo<CollectionPart[]>(() => {
    try {
      return collection?.parts ? (JSON.parse(collection.parts) as CollectionPart[]) : [];
    } catch {
      return [];
    }
  }, [collection?.parts]);
  if (!collection || parts.length < 2) return null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="px-12 pb-8">
      <h3 className="mb-1 text-2xl font-bold">{collection.name}</h3>
      <p className="mb-5 text-sm text-nf-secondary">Watch order · {parts.length} films</p>
      <div className="grid grid-cols-4 gap-4">
        {parts.map((part, i) => {
          const owned = items.find((x) => x.kind === 'movie' && x.tmdbId === part.tmdb_id);
          const current = owned?.key === item.key;
          const upcoming = !part.release_date || part.release_date > today;
          return (
            <button
              key={part.tmdb_id}
              type="button"
              disabled={!owned || current}
              onClick={() => owned && openDetail(owned.key)}
              className={`group text-left ${owned ? '' : 'cursor-default'}`}
            >
              <div
                className={`relative aspect-[2/3] overflow-hidden rounded-md bg-[#2f2f2f] ${
                  current ? 'ring-2 ring-white' : owned ? 'transition group-hover:ring-2 group-hover:ring-white/60' : ''
                }`}
              >
                <Artwork
                  src={owned?.poster ?? part.poster}
                  alt={part.title}
                  fallbackTitle={part.title}
                  className={`h-full w-full ${owned ? '' : 'opacity-35 grayscale'}`}
                />
                <span className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/75 text-sm font-bold">{i + 1}</span>
                {!owned && (
                  <span className="absolute inset-x-0 bottom-0 bg-black/75 px-2 py-1.5 text-center text-xs text-nf-secondary">
                    {upcoming ? (part.release_date ? `Coming ${part.year ?? ''}` : 'Coming soon') : 'Not in your library'}
                  </span>
                )}
              </div>
              <div className={`mt-2 truncate text-sm font-semibold ${owned ? '' : 'text-nf-muted'}`}>{part.title}</div>
              <div className="text-xs text-nf-muted">{part.year ?? 'TBA'}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Marks a whole season (or the show) watched or unwatched. */
function WatchedMenu({ episodes, season, seasonLabel }: { episodes: EpisodeRow[]; season: number; seasonLabel: string }) {
  const reload = useLibraryStore((s) => s.reload);
  const toast = useLibraryStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const inSeason = episodes.filter((e) => e.season_number === season);
  const run = async (list: EpisodeRow[], watched: boolean, label: string) => {
    setOpen(false);
    await setEpisodesWatched(list.map((e) => e.id), watched);
    await reload();
    toast(`${label} marked ${watched ? 'watched' : 'unwatched'}`, 'success');
  };
  const item = 'block w-full px-4 py-2 text-left text-sm hover:bg-white/10';
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} title="Mark watched or unwatched" className="nf-circle-btn h-11 w-11">
        <CheckCheck className="h-5 w-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-60 overflow-hidden rounded-md border border-white/15 bg-[#242424] py-1 shadow-2xl">
          {inSeason.length > 0 && (
            <>
              <button className={item} onClick={() => void run(inSeason, true, seasonLabel)}>
                Mark {seasonLabel} watched
              </button>
              <button className={item} onClick={() => void run(inSeason, false, seasonLabel)}>
                Mark {seasonLabel} unwatched
              </button>
              <div className="my-1 border-t border-white/10" />
            </>
          )}
          <button className={item} onClick={() => void run(episodes, true, 'Every episode')}>
            Mark whole show watched
          </button>
          <button className={item} onClick={() => void run(episodes, false, 'Every episode')}>
            Mark whole show unwatched
          </button>
        </div>
      )}
    </div>
  );
}

function MoreLikeThis({ item }: { item: MediaItem }) {
  const items = useLibraryStore((s) => s.items);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const toggleMyList = useLibraryStore((s) => s.toggleMyList);

  const similar = useMemo(() => {
    const mine = new Set(genreBuckets(item.genres));
    if (!mine.size) return [];
    return items
      .filter((i) => i.key !== item.key && i.matched)
      .map((i) => {
        const overlap = genreBuckets(i.genres).filter((g) => mine.has(g)).length;
        return { i, score: overlap * 10 + (i.kind === item.kind ? 3 : 0) + i.voteAverage / 2 };
      })
      .filter((x) => x.score >= 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, 9)
      .map((x) => x.i);
  }, [items, item]);

  if (!similar.length) return null;
  return (
    <section className="px-12 pb-8">
      <h3 className="mb-5 text-2xl font-bold">More Like This</h3>
      <div className="grid grid-cols-3 gap-4">
        {similar.map((s) => {
          const m = matchPercent(s.voteAverage);
          return (
            <div
              key={s.key}
              onClick={() => openDetail(s.key)}
              className="cursor-pointer overflow-hidden rounded-md bg-[#2f2f2f] transition-colors hover:bg-[#383838]"
            >
              <div className="relative aspect-video">
                <Artwork src={resize(s.backdrop, 'w500')} alt={s.title} fallbackTitle={s.title} className="h-full w-full" />
                <span className="absolute right-2 top-2 text-sm font-semibold text-shadow">
                  {s.kind === 'movie' ? formatRuntime(s.runtime) : `${s.seasonCount} Season${s.seasonCount === 1 ? '' : 's'}`}
                </span>
                <span className="absolute bottom-2 left-2 line-clamp-1 max-w-[90%] text-sm font-bold text-shadow">{s.title}</span>
              </div>
              <div className="space-y-2 p-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5 text-sm">
                    <div className="flex items-center gap-2">
                      {m != null && <span className="font-semibold text-nf-green">{m}% Match</span>}
                      <ImdbRating rating={s.imdbRating} className="text-xs" />
                    </div>
                    <div className="flex items-center gap-2 text-nf-secondary">
                      {s.year}
                      <TechBadges tech={s.tech} showCodec={false} showAudio={false} />
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMyList(s);
                    }}
                    className="nf-circle-btn h-9 w-9"
                  >
                    {s.myList ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  </button>
                </div>
                <p className="line-clamp-4 text-[13px] leading-snug text-[#d2d2d2]">{s.overview}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function About({ item, mediaInfo, size }: { item: MediaItem; mediaInfo: MediaItem['mediaInfo']; size?: number | null }) {
  const cast = item.cast.filter((c) => !c.job);
  const crew = item.cast.filter((c) => c.job);
  return (
    <section className="space-y-2 border-t-0 px-12 pb-12 text-sm">
      <h3 className="mb-4 text-2xl">
        About <span className="font-bold">{item.title}</span>
      </h3>
      {crew.length > 0 && (
        <p>
          <span className="text-nf-muted">{crew[0].job === 'Creator' ? 'Creators' : 'Director'}: </span>
          <CastLinks people={crew} />
        </p>
      )}
      {cast.length > 0 && (
        <p>
          <span className="text-nf-muted">Cast: </span>
          <CastLinks people={cast} />
        </p>
      )}
      {item.genres.length > 0 && (
        <p>
          <span className="text-nf-muted">Genres: </span>
          {item.genres.join(', ')}
        </p>
      )}
      {(item.tech.resolution || item.tech.hdr_format || item.tech.video_codec || item.tech.audio_codec) && (
        <p>
          <span className="text-nf-muted">Quality: </span>
          <TechBadges tech={item.tech} size="sm" className="align-middle" />
        </p>
      )}
      {item.certification && (
        <p>
          <span className="text-nf-muted">Maturity rating: </span>
          <MaturityRating rating={item.certification} className="align-middle" />
        </p>
      )}
      <StreamInfo info={mediaInfo} size={size} />
    </section>
  );
}
