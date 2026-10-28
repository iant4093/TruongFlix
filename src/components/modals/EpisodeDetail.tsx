import { useState } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Eye, FolderOpen, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { deleteMedia, FILE_MANAGER_NAME, revealInFileManager } from '../../services/files';
import type { EpisodeRow, MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { epLabel, episodeTarget, formatRemaining } from '../../store/selectors';
import { play } from '../../services/player';
import { setWatched } from '../../services/db';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import ProgressBar from '../common/ProgressBar';
import TechBadges from '../common/TechBadges';
import SubtitlesPanel from '../common/SubtitlesPanel';
import ImdbRating from '../common/ImdbRating';
import MaturityRating from '../common/MaturityRating';
import { CastLinks, StreamInfo } from '../common/StreamInfo';
import { parseMediaInfo, parseSegments } from '../../services/mediainfo';

interface Props {
  series: MediaItem;
  episode: EpisodeRow;
  /** All episodes of the series, sorted by season/episode. */
  episodes: EpisodeRow[];
}

function formatAirDate(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Full page for a single episode, shown inside the series detail modal. */
export default function EpisodeDetail({ series, episode: ep, episodes }: Props) {
  const openEpisode = useLibraryStore((s) => s.openEpisode);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const reload = useLibraryStore((s) => s.reload);
  const toast = useLibraryStore((s) => s.toast);
  const [logoFailed, setLogoFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const idx = episodes.findIndex((e) => e.id === ep.id);
  const prev = idx > 0 ? episodes[idx - 1] : null;
  const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;
  const inSeason = episodes.filter((e) => e.season_number === ep.season_number).length;

  const duration = ep.duration_seconds || (ep.runtime ?? 0) * 60;
  const inProgress = !ep.watched && ep.progress_seconds > 0;
  const progress = inProgress && duration ? ep.progress_seconds / duration : 0;
  const target = episodeTarget(ep, series);
  const imdbEnabled = useLibraryStore((s) => s.settings.imdb_enabled);
  const seasonRating = series.imdbSeasons[ep.season_number];
  const cast = series.cast.filter((c) => !c.job);
  const airDate = formatAirDate(ep.air_date);
  const heroImage = ep.still_path ? resize(ep.still_path, 'original') : resize(series.backdrop, 'w1280');

  const toggleWatched = async () => {
    setBusy(true);
    try {
      await setWatched('episode', ep.id, !ep.watched);
      await reload();
      toast(ep.watched ? `Marked ${epLabel(ep)} as unwatched` : `Marked ${epLabel(ep)} as watched`, 'success');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="relative aspect-video w-full">
        <Artwork src={heroImage} alt={ep.title} fallbackTitle={ep.title} className="h-full w-full" eager />
        <div className="absolute inset-0 bg-gradient-to-t from-nf-surface via-nf-surface/20 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/50 via-transparent to-transparent" />

        <button
          onClick={() => openEpisode(null)}
          className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-full bg-nf-surface/90 py-2 pl-2.5 pr-4 text-sm font-semibold text-white hover:bg-[#2a2a2a]"
        >
          <ArrowLeft className="h-4 w-4" />
          {series.title}
        </button>
        <button
          onClick={() => openDetail(null)}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-nf-surface text-white hover:bg-[#2a2a2a]"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="absolute bottom-[8%] left-12 right-12 flex flex-col gap-3">
          {series.logo && !logoFailed ? (
            <img
              src={series.logo}
              alt={series.title}
              onError={() => setLogoFailed(true)}
              draggable={false}
              className="max-h-[56px] max-w-[30%] self-start object-contain object-left drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
            />
          ) : (
            <span className="text-shadow text-lg font-black uppercase tracking-tight text-white/90">{series.title}</span>
          )}
          <div>
            <div className="text-shadow text-sm font-semibold uppercase tracking-widest text-white/70">
              {ep.season_number === 0 ? 'Special' : `Season ${ep.season_number}`} · Episode {ep.episode_number}
            </div>
            <h2 className="text-shadow mt-1 max-w-[80%] text-4xl font-bold leading-tight">{ep.title}</h2>
          </div>
          <div className="mt-1 flex items-center gap-2.5">
            <button onClick={() => play(target)} className="nf-btn-play px-8 text-lg">
              <Play className="h-6 w-6 fill-black" strokeWidth={0} />
              {inProgress ? 'Resume' : 'Play'}
            </button>
            {inProgress && (
              <button
                onClick={() => play({ ...target, startTime: 0 })}
                title="Play from beginning"
                className="nf-circle-btn h-11 w-11"
              >
                <RotateCcw className="h-5 w-5" />
              </button>
            )}
            <button
              onClick={toggleWatched}
              disabled={busy}
              title={ep.watched ? 'Mark as unwatched' : 'Mark as watched'}
              className={`nf-circle-btn h-11 w-11 ${ep.watched ? '!border-white bg-white/10' : ''}`}
            >
              {ep.watched ? <Check className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
            <button
              onClick={() => revealInFileManager(ep.file_path).catch((e) => toast(String(e), 'error'))}
              title={`Show in ${FILE_MANAGER_NAME}`}
              className="nf-circle-btn h-11 w-11"
            >
              <FolderOpen className="h-5 w-5" />
            </button>
            <button
              onClick={async () => {
                if (await deleteMedia({ kind: 'episode', episode: ep, series })) openEpisode(null);
              }}
              title="Delete episode"
              className="nf-circle-btn h-11 w-11 hover:!border-nf-red hover:!bg-nf-red/20"
            >
              <Trash2 className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[65%_35%] gap-8 px-12 pb-8 pt-2">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[15px]">
            <ImdbRating rating={ep.imdb_rating} votes={ep.imdb_votes} imdbId={ep.imdb_id} showVotes size="md" />
            <span className="text-nf-secondary">{epLabel(ep)}</span>
            {airDate && <span className="text-nf-secondary">{airDate}</span>}
            {ep.runtime ? <span className="text-nf-secondary">{ep.runtime}m</span> : null}
            <MaturityRating rating={series.certification} size="md" />
            <TechBadges tech={ep} size="md" />
          </div>

          {inProgress && (
            <div className="flex items-center gap-3 text-sm text-nf-secondary">
              <ProgressBar value={progress} height={4} className="max-w-[220px] rounded-sm" />
              <span className="whitespace-nowrap">{formatRemaining(duration - ep.progress_seconds)}</span>
            </div>
          )}
          {ep.watched ? (
            <div className="flex items-center gap-1.5 text-sm text-nf-secondary">
              <Check className="h-4 w-4 text-nf-green" /> Watched
            </div>
          ) : null}

          <p className="text-[15px] leading-relaxed text-white">{ep.overview || 'No description available for this episode.'}</p>

          <div className="space-y-0.5">
            <p className="selectable break-all font-mono text-[11px] text-nf-muted">File: {ep.file_path}</p>
          </div>
        </div>

        <div className="space-y-3 text-sm leading-relaxed">
          <p>
            <span className="text-nf-muted">Series: </span>
            <button onClick={() => openEpisode(null)} className="hover:underline">
              {series.title}
              {series.year ? ` (${series.year})` : ''}
            </button>
          </p>
          <p>
            <span className="text-nf-muted">Episode: </span>
            {ep.episode_number} of {inSeason} in {ep.season_number === 0 ? 'Specials' : `Season ${ep.season_number}`}
          </p>
          {imdbEnabled && (series.imdbRating != null || seasonRating) && (
            <div className="space-y-1.5">
              <span className="text-nf-muted">IMDb: </span>
              <div className="flex flex-col gap-1">
                {seasonRating && <ImdbRating rating={seasonRating.rating} suffix={`Season ${ep.season_number} avg`} />}
                <ImdbRating rating={series.imdbRating} votes={series.imdbVotes} imdbId={series.imdbId} showVotes suffix="series" />
              </div>
            </div>
          )}
          {cast.length > 0 && (
            <p>
              <span className="text-nf-muted">Cast: </span>
              <CastLinks people={cast} limit={4} />
            </p>
          )}
          <IntroInfo segments={ep.segments} />
          <StreamInfo info={parseMediaInfo(ep.media_info)} size={ep.file_size} />
          {series.genres.length > 0 && (
            <p>
              <span className="text-nf-muted">Genres: </span>
              {series.genres.join(', ')}
            </p>
          )}
        </div>
      </div>

      <SubtitlesPanel
        target={{
          type: 'episode',
          id: ep.id,
          filePath: ep.file_path,
          parentTmdbId: series.tmdbId,
          season: ep.season_number,
          episode: ep.episode_number,
          fallbackQuery: `${series.title} S${String(ep.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`,
        }}
      />

      {(prev || next) && (
        <section className="grid grid-cols-2 gap-4 px-12 pb-12">
          {[prev, next].map((other, i) =>
            other ? (
              <button
                key={other.id}
                onClick={() => openEpisode(other.id)}
                className="group flex items-center gap-4 rounded-md bg-[#2f2f2f] p-3 text-left transition-colors hover:bg-[#383838]"
              >
                {i === 0 && <ChevronLeft className="h-5 w-5 shrink-0 text-white/60 group-hover:text-white" />}
                <div className="relative aspect-video w-[120px] shrink-0 overflow-hidden rounded">
                  <Artwork src={other.still_path ?? resize(series.backdrop, 'w300')} alt={other.title} className="h-full w-full" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold uppercase tracking-wider text-nf-muted">
                    {i === 0 ? 'Previous' : 'Next'} · {epLabel(other)}
                  </div>
                  <div className="truncate font-semibold">{other.title}</div>
                </div>
                {i === 1 && <ChevronRight className="h-5 w-5 shrink-0 text-white/60 group-hover:text-white" />}
              </button>
            ) : (
              <div key={i} />
            ),
          )}
        </section>
      )}
    </>
  );
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

/** Detected intro / recap / credits, so it's clear what Skip Intro will do. */
function IntroInfo({ segments }: { segments: string | null }) {
  const list = parseSegments(segments);
  if (!list.length) return null;
  const name = { intro: 'Intro', recap: 'Recap', credits: 'Credits' } as const;
  return (
    <p>
      <span className="text-nf-muted">Skippable: </span>
      {list
        .sort((a, b) => a.start - b.start)
        .map((x) => `${name[x.kind]} ${clock(x.start)}–${clock(x.end)}`)
        .join(' · ')}
    </p>
  );
}
