import type {
  CastMember,
  ContinueEntry,
  EpisodeRow,
  Maturity,
  MediaItem,
  MovieRow,
  MovieVersion,
  NextEpisode,
  PlayTarget,
  SeasonRating,
  SeriesRow,
  TechInfo,
} from '../types/media';
import { formatSize, parseMediaInfo } from '../services/mediainfo';

const parseJson = <T,>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const RES_RANK: Record<string, number> = { '4K': 3, HD: 2, '720p': 1 };
const resRank = (r: string | null) => (r ? (RES_RANK[r] ?? 0) : 0);

function bestTech(rows: TechInfo[]): TechInfo {
  const out: TechInfo = { resolution: null, video_codec: null, hdr_format: null, audio_codec: null };
  for (const r of rows) {
    if (resRank(r.resolution) > resRank(out.resolution)) out.resolution = r.resolution;
    if (!out.hdr_format || r.hdr_format === 'Dolby Vision') out.hdr_format = r.hdr_format ?? out.hdr_format;
    out.video_codec ??= r.video_codec;
    if (!out.audio_codec || (r.audio_codec?.length ?? 0) > out.audio_codec.length) out.audio_codec = r.audio_codec ?? out.audio_codec;
  }
  return out;
}

const techOf = (r: TechInfo): TechInfo => ({ resolution: r.resolution, video_codec: r.video_codec, hdr_format: r.hdr_format, audio_codec: r.audio_codec });

function versionLabel(m: MovieRow): string {
  const res = m.resolution === 'HD' ? '1080p' : m.resolution;
  return [res ?? 'Unknown quality', m.hdr_format, m.video_codec, formatSize(m.file_size)].filter(Boolean).join(' · ');
}

const qualityScore = (r: MovieRow) => resRank(r.resolution) * 10 + (r.hdr_format === 'Dolby Vision' ? 3 : r.hdr_format ? 2 : 0) + (r.file_size ?? 0) / 1e13;

function movieToItem(m: MovieRow, all: MovieRow[] = [m]): MediaItem {
  const versions: MovieVersion[] = [...all]
    .sort((a, b) => qualityScore(b) - qualityScore(a))
    .map((v) => ({ id: v.id, filePath: v.file_path, label: versionLabel(v), tech: techOf(v), fileSize: v.file_size }));
  return {
    key: `movie-${m.id}`,
    kind: 'movie',
    id: m.id,
    tmdbId: m.tmdb_id,
    title: m.title,
    year: m.year,
    overview: m.overview ?? '',
    tagline: m.tagline,
    voteAverage: m.vote_average ?? 0,
    genres: parseJson<string[]>(m.genres, []),
    cast: parseJson<CastMember[]>(m.cast_crew, []),
    poster: m.poster_path,
    backdrop: m.backdrop_path,
    logo: m.logo_path,
    runtime: m.runtime,
    seasonCount: 0,
    episodeCount: 0,
    tech: { resolution: m.resolution, video_codec: m.video_codec, hdr_format: m.hdr_format, audio_codec: m.audio_codec },
    myList: !!m.my_list,
    createdAt: m.created_at,
    lastWatchedAt: m.last_watched_at,
    matched: m.tmdb_id != null,
    imdbId: m.imdb_id || null,
    imdbRating: m.imdb_rating ?? null,
    imdbVotes: m.imdb_votes ?? null,
    imdbSeasons: {},
    certification: m.certification || null,
    trailerKey: m.trailer_key || null,
    collectionId: m.collection_id || null,
    collectionName: m.collection_name,
    tmdbStatus: null,
    nextEpisode: null,
    tmdbSeasons: 0,
    versions,
    mediaInfo: parseMediaInfo(m.media_info),
    filePath: m.file_path,
    rawFilename: m.raw_filename,
    progressSeconds: m.progress_seconds ?? 0,
    durationSeconds: m.duration_seconds ?? 0,
    watched: !!m.watched,
  };
}

function seriesToItem(s: SeriesRow, eps: EpisodeRow[]): MediaItem {
  const seasons = new Set(eps.map((e) => e.season_number));
  return {
    key: `tv-${s.id}`,
    kind: 'tv',
    id: s.id,
    tmdbId: s.tmdb_id > 0 ? s.tmdb_id : null,
    title: s.title,
    year: s.year,
    overview: s.overview ?? '',
    tagline: null,
    voteAverage: s.vote_average ?? 0,
    genres: parseJson<string[]>(s.genres, []),
    cast: parseJson<CastMember[]>(s.cast_crew, []),
    poster: s.poster_path,
    backdrop: s.backdrop_path,
    logo: s.logo_path,
    runtime: null,
    seasonCount: seasons.size,
    episodeCount: eps.length,
    tech: bestTech(eps),
    myList: !!s.my_list,
    createdAt: s.created_at,
    lastWatchedAt: s.last_watched_at,
    matched: s.tmdb_id > 0,
    imdbId: s.imdb_id || null,
    imdbRating: s.imdb_rating ?? null,
    imdbVotes: s.imdb_votes ?? null,
    imdbSeasons: parseJson<Record<number, SeasonRating>>(s.imdb_season_ratings, {}),
    certification: s.certification || null,
    trailerKey: s.trailer_key || null,
    collectionId: null,
    collectionName: null,
    tmdbStatus: s.tmdb_status,
    nextEpisode: parseJson<NextEpisode | null>(s.next_episode, null),
    tmdbSeasons: s.tmdb_id > 0 ? s.number_of_seasons : 0,
    versions: [],
    mediaInfo: null,
    filePath: null,
    rawFilename: null,
    progressSeconds: 0,
    durationSeconds: 0,
    watched: eps.length > 0 && eps.every((e) => !!e.watched),
  };
}

/** Builds unified items. Duplicate movie files sharing a TMDB id collapse into one card. */
export function buildItems(movies: MovieRow[], series: SeriesRow[], episodesBySeries: Map<number, EpisodeRow[]>): MediaItem[] {
  const groups = new Map<number, MovieRow[]>();
  const singles: MovieRow[] = [];
  for (const m of movies) {
    if (m.tmdb_id == null) singles.push(m);
    else groups.set(m.tmdb_id, [...(groups.get(m.tmdb_id) ?? []), m]);
  }
  // The card shows the version being watched, otherwise the highest quality.
  const score = (r: MovieRow) => (r.last_watched_at ? 1000 : 0) + qualityScore(r);
  const items = [
    ...[...groups.values()].map((rows) => movieToItem(rows.reduce((a, b) => (score(b) > score(a) ? b : a)), rows)),
    ...singles.map((m) => movieToItem(m)),
  ];
  for (const s of series) items.push(seriesToItem(s, episodesBySeries.get(s.id) ?? []));
  return items;
}

export function groupEpisodes(episodes: EpisodeRow[]): Map<number, EpisodeRow[]> {
  const map = new Map<number, EpisodeRow[]>();
  for (const e of episodes) {
    const list = map.get(e.series_id);
    if (list) list.push(e);
    else map.set(e.series_id, [e]);
  }
  for (const list of map.values()) list.sort((a, b) => a.season_number - b.season_number || a.episode_number - b.episode_number);
  return map;
}

export const epLabel = (e: Pick<EpisodeRow, 'season_number' | 'episode_number'>) => `S${e.season_number}:E${e.episode_number}`;

export function episodeTarget(e: EpisodeRow, series: { title: string }): PlayTarget {
  return {
    type: 'episode',
    id: e.id,
    filePath: e.file_path,
    startTime: e.watched ? 0 : (e.progress_seconds ?? 0),
    label: `${series.title} · ${epLabel(e)} “${e.title}”`,
  };
}

/**
 * TV "Next Up": the in-progress episode, or — if the last-watched episode was completed —
 * the following episode (SxxE(xx+1), rolling over to S(xx+1)E01).
 */
export function nextUpEpisode(eps: EpisodeRow[]): EpisodeRow | null {
  const touched = eps.filter((e) => e.last_watched_at);
  if (!touched.length) return null;
  const last = touched.reduce((a, b) => ((b.last_watched_at ?? '') > (a.last_watched_at ?? '') ? b : a));
  if (!last.watched && last.progress_seconds > 0) return last;
  if (!last.watched) return null;
  const idx = eps.indexOf(last);
  return eps.slice(idx + 1).find((e) => e.season_number > 0) ?? null;
}

/** What "Play" on a series should start: Next Up, otherwise the first regular episode. */
export function seriesPlayEpisode(eps: EpisodeRow[]): EpisodeRow | null {
  return nextUpEpisode(eps) ?? eps.find((e) => e.season_number > 0 && !e.watched) ?? eps.find((e) => e.season_number > 0) ?? eps[0] ?? null;
}

export function playTargetFor(item: MediaItem, episodesBySeries: Map<number, EpisodeRow[]>): PlayTarget | null {
  if (item.kind === 'movie') {
    if (!item.filePath) return null;
    return {
      type: 'movie',
      id: item.id,
      filePath: item.filePath,
      startTime: item.watched ? 0 : item.progressSeconds,
      label: item.title,
    };
  }
  const ep = seriesPlayEpisode(episodesBySeries.get(item.id) ?? []);
  return ep ? episodeTarget(ep, item) : null;
}

export function continueWatching(items: MediaItem[], episodesBySeries: Map<number, EpisodeRow[]>): ContinueEntry[] {
  const out: ContinueEntry[] = [];
  for (const item of items) {
    if (item.kind === 'movie') {
      if (item.watched || item.progressSeconds <= 0 || !item.lastWatchedAt) continue;
      const target = playTargetFor(item, episodesBySeries)!;
      const dur = item.durationSeconds || (item.runtime ?? 0) * 60;
      out.push({
        item,
        target,
        episode: null,
        progress: dur ? Math.min(1, item.progressSeconds / dur) : 0,
        remainingSeconds: Math.max(0, dur - item.progressSeconds),
        sortDate: item.lastWatchedAt,
      });
    } else {
      if (!item.lastWatchedAt) continue;
      const eps = episodesBySeries.get(item.id) ?? [];
      const ep = nextUpEpisode(eps);
      if (!ep) continue;
      const dur = ep.duration_seconds || (ep.runtime ?? 0) * 60;
      const prog = ep.watched ? 0 : ep.progress_seconds;
      out.push({
        item,
        target: episodeTarget(ep, item),
        episode: ep,
        progress: dur ? Math.min(1, prog / dur) : 0,
        remainingSeconds: Math.max(0, dur - prog),
        sortDate: item.lastWatchedAt,
      });
    }
  }
  return out.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
}

export const matchPercent = (vote: number) => (vote > 0 ? Math.round(vote * 10) : null);

export function formatRuntime(minutes: number | null | undefined): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function formatRemaining(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m <= 0) return '';
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

export function formatTimestamp(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Normalises TMDB TV genres ("Sci-Fi & Fantasy") onto movie-style row names. */
export function genreBuckets(genres: string[]): string[] {
  const out = new Set<string>();
  for (const g of genres) {
    if (g === 'Action & Adventure') out.add('Action & Adventure');
    else if (g === 'Action' || g === 'Adventure') out.add('Action & Adventure');
    else if (g === 'Sci-Fi & Fantasy') {
      out.add('Sci-Fi');
      out.add('Fantasy');
    } else if (g === 'Science Fiction') out.add('Sci-Fi');
    else if (g === 'War & Politics') out.add('War');
    else out.add(g);
  }
  return [...out];
}

export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Age ratings & profiles
// ---------------------------------------------------------------------------

const CERT_LEVEL: Record<string, number> = {
  G: 0, 'TV-Y': 0, 'TV-Y7': 0, 'TV-Y7-FV': 0, 'TV-G': 0,
  PG: 1, 'TV-PG': 1,
  'PG-13': 2, 'TV-14': 2,
  R: 3, 'NC-17': 3, 'TV-MA': 3, NR: 3, Unrated: 3,
};

/** Kids: G/PG/TV-PG and below. Teen: up to PG-13/TV-14. Unrated titles are hidden on both. */
export function allowedForMaturity(item: MediaItem, maturity: Maturity): boolean {
  if (maturity === 'all') return true;
  const level = item.certification ? CERT_LEVEL[item.certification] : undefined;
  if (level == null) return false;
  return level <= (maturity === 'kids' ? 1 : 2);
}

export const MATURITY_LABEL: Record<Maturity, string> = { kids: 'Kids', teen: 'Teens', all: 'All Maturity Ratings' };

/** "Friday" within a week, otherwise "Nov 6". */
export function airDayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const days = (d.getTime() - Date.now()) / 864e5;
  if (days < -0.5) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days < 0.5) return 'Today';
  if (days < 1.5) return 'Tomorrow';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The next episode airs within the coming week (or aired in the last few days). */
export const newEpisodeSoon = (n: NextEpisode | null) => {
  if (!n) return false;
  const days = (new Date(`${n.air_date}T12:00:00`).getTime() - Date.now()) / 864e5;
  return days > -4 && days < 7;
};
