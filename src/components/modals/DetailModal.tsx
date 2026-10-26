import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronRight, FolderOpen, Play, Plus, Trash2, Wrench, X } from 'lucide-react';
import { deleteMedia, FILE_MANAGER_NAME, revealInFileManager } from '../../services/files';
import EpisodeDetail from './EpisodeDetail';
import SubtitlesPanel from '../common/SubtitlesPanel';
import Dropdown from '../common/Dropdown';
import ImdbRating from '../common/ImdbRating';
import type { EpisodeRow, MediaItem } from '../../types/media';
import { selectItem, useLibraryStore } from '../../store/useLibraryStore';
import {
  continueWatching,
  epLabel,
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
  const target = playTargetFor(item, episodesBySeries);
  const resumeEntry = useMemo(
    () => continueWatching([item], episodesBySeries)[0] ?? null,
    [item, episodesBySeries],
  );

  const match = matchPercent(item.voteAverage);
  const cast = item.cast.filter((c) => !c.job);
  const crew = item.cast.filter((c) => c.job);
  const genres = item.genres;

  const toast = useLibraryStore((s) => s.toast);
  const revealPath = item.kind === 'movie' ? item.filePath : (episodes[0]?.file_path ?? null);
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
            {item.year && <span className="text-nf-secondary">{item.year}</span>}
            {item.kind === 'movie' && item.runtime ? <span className="text-nf-secondary">{formatRuntime(item.runtime)}</span> : null}
            {item.kind === 'tv' && (
              <span className="text-nf-secondary">
                {item.seasonCount} Season{item.seasonCount === 1 ? '' : 's'}
              </span>
            )}
            <TechBadges tech={item.tech} size="md" />
          </div>

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
            <p className="selectable break-all font-mono text-[11px] text-nf-muted">File: {item.filePath}</p>
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
              {cast.slice(0, 4).map((c) => c.name).join(', ')}
              {cast.length > 4 && <span className="italic text-white/80">, more</span>}
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
              {crew.map((c) => c.name).join(', ')}
            </p>
          )}
        </div>
      </div>

      {item.kind === 'tv' && (
        <EpisodeSelector item={item} episodes={episodes} season={season} onSeasonChange={onSeasonChange} />
      )}
      {item.kind === 'movie' && item.filePath && (
        <SubtitlesPanel
          target={{
            type: 'movie',
            id: item.id,
            filePath: item.filePath,
            tmdbId: item.tmdbId,
            fallbackQuery: item.rawFilename?.replace(/\.[^.]+$/, '') ?? item.title,
          }}
        />
      )}
      <MoreLikeThis item={item} />
      <About item={item} />
    </>
  );
}

interface SelectorProps {
  item: MediaItem;
  episodes: EpisodeRow[];
  season: number | null;
  onSeasonChange: (season: number) => void;
}

function EpisodeSelector({ item, episodes, season: chosenSeason, onSeasonChange }: SelectorProps) {
  const seasons = useMemo(() => [...new Set(episodes.map((e) => e.season_number))].sort((a, b) => a - b), [episodes]);
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
  const seasonName = (s: number) => (s === 0 ? 'Specials' : `Season ${s}`);
  const seasonOptions = seasons.map((s) => {
    const n = episodes.filter((e) => e.season_number === s).length;
    const avg = item.imdbSeasons[s]?.rating;
    const imdbHint = avg != null && imdbEnabled ? ` · ★ ${avg.toFixed(1)}` : '';
    return { value: s, label: seasonName(s), hint: `${n} Episode${n === 1 ? '' : 's'}${imdbHint}` };
  });

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

      <div>
        {list.map((ep) => {
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

function About({ item }: { item: MediaItem }) {
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
          {crew.map((c) => c.name).join(', ')}
        </p>
      )}
      {cast.length > 0 && (
        <p>
          <span className="text-nf-muted">Cast: </span>
          {cast.map((c) => c.name).join(', ')}
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
    </section>
  );
}
