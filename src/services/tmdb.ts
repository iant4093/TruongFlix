import type { CastMember, CollectionPart } from '../types/media';
import type { EpisodeMetadata, MovieExtras, MovieMetadata, SeriesExtras, SeriesMetadata } from './db';
import { saveSeasonCache } from './db';
import type { CatalogDetail, CatalogSeason } from '../types/browse';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

export const img = (path: string | null | undefined, size: 'w92' | 'w185' | 'w342' | 'w300' | 'w500' | 'w780' | 'w1280' | 'original') =>
  path ? `${IMG}/${size}${path}` : null;

/** Re-sizes a stored TMDB URL (e.g. original backdrop -> w780 for card thumbnails). */
export function resize(url: string | null | undefined, size: string): string | null {
  if (!url) return null;
  return url.replace(/\/t\/p\/[^/]+\//, `/t/p/${size}/`);
}

export class TmdbError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public network = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Rate-limited request queue (TMDB allows ~50 req/s; stay well below)
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 6;
const MIN_INTERVAL_MS = 25;

let apiKey = '';
let active = 0;
let lastStart = 0;
const waiting: (() => void)[] = [];

export function setApiKey(key: string) {
  apiKey = key.trim();
}

function acquire(): Promise<void> {
  return new Promise((resolve) => {
    const tryStart = () => {
      if (active >= MAX_CONCURRENT) return waiting.push(tryStart);
      const wait = lastStart + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) return void setTimeout(tryStart, wait);
      active++;
      lastStart = Date.now();
      resolve();
    };
    tryStart();
  });
}

function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isBearer = (key: string) => key.startsWith('eyJ');

async function request<T>(path: string, params: Record<string, string | number | undefined> = {}, key = apiKey): Promise<T> {
  if (!key) throw new TmdbError('TMDB API key is not configured', 401);
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isBearer(key)) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  for (let attempt = 0; attempt < 4; attempt++) {
    await acquire();
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers });
    } catch (e) {
      release();
      if (attempt === 3) throw new TmdbError(`Network error: ${String(e)}`, null, true);
      await sleep(500 * (attempt + 1));
      continue;
    }
    release();
    if (res.status === 429) {
      const retry = Number(res.headers.get('Retry-After')) || 1;
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).status_message ?? msg;
      } catch {
        /* ignore */
      }
      throw new TmdbError(msg, res.status);
    }
    return (await res.json()) as T;
  }
  throw new TmdbError('TMDB rate limit exceeded', 429);
}

export async function validateApiKey(key: string): Promise<boolean> {
  try {
    await request('/configuration', {}, key.trim());
    return true;
  } catch (e) {
    if (e instanceof TmdbError && e.network) throw e;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Raw response shapes
// ---------------------------------------------------------------------------

interface TmdbImage {
  file_path: string;
  iso_639_1: string | null;
  vote_average: number;
  vote_count: number;
}
interface TmdbCredits {
  cast?: { id: number; name: string; character?: string; profile_path?: string | null; order?: number }[];
  crew?: { id: number; name: string; job?: string; profile_path?: string | null }[];
}
interface TmdbMovie {
  status?: string;
  original_language?: string;
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  tagline?: string;
  runtime?: number;
  vote_average?: number;
  genres?: { name: string }[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  credits?: TmdbCredits;
  images?: { logos?: TmdbImage[] };
  imdb_id?: string | null;
  release_dates?: { results?: { iso_3166_1: string; release_dates: { certification: string; type: number }[] }[] };
  videos?: { results?: TmdbVideo[] };
  belongs_to_collection?: { id: number; name: string } | null;
  keywords?: { keywords?: { id: number; name: string }[] };
}
interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  official?: boolean;
  iso_639_1?: string;
  published_at?: string;
  size?: number;
}
interface TmdbNextEpisode {
  season_number: number;
  episode_number: number;
  name: string;
  air_date: string | null;
}
interface TmdbTv {
  tagline?: string;
  original_language?: string;
  episode_run_time?: number[];
  number_of_episodes?: number;
  networks?: { name: string }[];
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  vote_average?: number;
  number_of_seasons?: number;
  genres?: { name: string }[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  created_by?: { id: number; name: string; profile_path?: string | null }[];
  credits?: TmdbCredits;
  images?: { logos?: TmdbImage[] };
  external_ids?: { imdb_id?: string | null };
  content_ratings?: { results?: { iso_3166_1: string; rating: string }[] };
  videos?: { results?: TmdbVideo[] };
  status?: string;
  next_episode_to_air?: TmdbNextEpisode | null;
  last_episode_to_air?: TmdbNextEpisode | null;
  seasons?: { season_number: number; name: string; episode_count: number; air_date?: string | null }[];
}
interface TmdbEpisode {
  id: number;
  name: string;
  overview?: string;
  still_path?: string | null;
  air_date?: string | null;
  runtime?: number | null;
  season_number: number;
  episode_number: number;
}

export interface SearchResult {
  id: number;
  kind: 'movie' | 'tv';
  title: string;
  year: number | null;
  releaseDate?: string | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  voteAverage: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const yearOf = (date?: string | null) => (date && /^\d{4}/.test(date) ? parseInt(date.slice(0, 4), 10) : null);
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');

/** Highest-voted English PNG logo (the Netflix-style "ClearLogo"). */
function pickLogo(logos: TmdbImage[] | undefined): string | null {
  if (!logos?.length) return null;
  const rank = (l: TmdbImage) => [l.vote_average, l.vote_count];
  const sorted = [...logos].sort((a, b) => rank(b)[0] - rank(a)[0] || rank(b)[1] - rank(a)[1]);
  const png = (l: TmdbImage) => l.file_path.toLowerCase().endsWith('.png');
  const best =
    sorted.find((l) => l.iso_639_1 === 'en' && png(l)) ??
    sorted.find((l) => l.iso_639_1 == null && png(l)) ??
    sorted.find((l) => png(l));
  return best ? img(best.file_path, 'w500') : null;
}

function castFrom(credits: TmdbCredits | undefined, creators: TmdbTv['created_by'] = []): CastMember[] {
  const cast: CastMember[] = (credits?.cast ?? []).slice(0, 10).map((c) => ({
    id: c.id,
    name: c.name,
    character: c.character,
    profile_path: img(c.profile_path, 'w185'),
  }));
  const directors = (credits?.crew ?? [])
    .filter((c) => c.job === 'Director')
    .slice(0, 2)
    .map((c) => ({ id: c.id, name: c.name, job: 'Director', profile_path: img(c.profile_path, 'w185') }));
  const creatorList = creators.slice(0, 2).map((c) => ({ id: c.id, name: c.name, job: 'Creator', profile_path: img(c.profile_path, 'w185') }));
  return [...cast, ...directors, ...creatorList];
}

/** Picks results[0], unless a later top-5 result is an exact title (+year) match. */
function pickBest<T extends { id: number }>(results: T[], title: string, year: number | null, getTitle: (r: T) => string[], getYear: (r: T) => number | null) {
  if (!results.length) return null;
  const target = norm(title);
  const top = results.slice(0, 5);
  return (
    top.find((r) => getTitle(r).some((t) => norm(t) === target) && (year == null || getYear(r) === year)) ??
    top.find((r) => getTitle(r).some((t) => norm(t) === target)) ??
    results[0]
  );
}

// ---------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------

interface MovieSearchHit {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
}

async function rawSearchMovie(query: string, year?: number | null) {
  const data = await request<{ results: MovieSearchHit[] }>('/search/movie', {
    query,
    primary_release_year: year ?? undefined,
    include_adult: 'false',
  });
  return data.results ?? [];
}

/** Search with the year, then retry without it (festival vs. theatrical year mismatches). */
export async function findMovie(title: string, year: number | null): Promise<number | null> {
  let results = await rawSearchMovie(title, year);
  if (!results.length && year != null) results = await rawSearchMovie(title);
  const best = pickBest(results, title, year, (r) => [r.title, r.original_title ?? ''], (r) => yearOf(r.release_date));
  return best?.id ?? null;
}

export async function getMovieDetails(tmdbId: number): Promise<MovieMetadata> {
  const d = await request<TmdbMovie>(`/movie/${tmdbId}`, {
    append_to_response: 'credits,images,release_dates,videos,keywords',
    include_image_language: 'en,null',
  });
  return {
    tmdb_id: d.id,
    title: d.title,
    original_title: d.original_title ?? null,
    year: yearOf(d.release_date),
    overview: d.overview || null,
    tagline: d.tagline || null,
    runtime: d.runtime || null,
    vote_average: d.vote_average ?? null,
    genres: (d.genres ?? []).map((g) => g.name),
    cast_crew: castFrom(d.credits),
    poster_path: img(d.poster_path, 'w500'),
    backdrop_path: img(d.backdrop_path, 'w1280'),
    logo_path: pickLogo(d.images?.logos),
    imdb_id: d.imdb_id || '',
    extras: movieExtras(d),
  };
}

function movieExtras(d: TmdbMovie): MovieExtras {
  const us = d.release_dates?.results?.find((r) => r.iso_3166_1 === 'US');
  const dates = [...(us?.release_dates ?? [])].sort((a, b) => (a.type === 3 ? -1 : 0) - (b.type === 3 ? -1 : 0));
  return {
    certification: dates.find((r) => r.certification)?.certification ?? '',
    collection_id: d.belongs_to_collection?.id ?? 0,
    collection_name: d.belongs_to_collection?.name ?? null,
    trailer_key: pickTrailer(d.videos?.results),
    stinger: stingerOf(d),
  };
}

/** TMDB tags movies with "duringcreditsstinger" / "aftercreditsstinger" when there's a scene in or after the credits. */
function stingerOf(d: TmdbMovie): string {
  const names = new Set((d.keywords?.keywords ?? []).map((k) => k.name.toLowerCase()));
  const during = names.has('duringcreditsstinger');
  const after = names.has('aftercreditsstinger');
  return during && after ? 'both' : during ? 'during' : after ? 'after' : '';
}

/** Best YouTube trailer: official English trailer, then any trailer, then a teaser. */
function rankedTrailers(videos: TmdbVideo[] | undefined): TmdbVideo[] {
  const yt = (videos ?? []).filter((v) => v.site === 'YouTube' && /^[\w-]{11}$/.test(v.key) && ['Trailer', 'Teaser'].includes(v.type));
  const rank = (v: TmdbVideo) =>
    (v.type === 'Trailer' ? 4 : v.type === 'Teaser' ? 2 : 0) + (v.official ? 2 : 0) + (v.iso_639_1 === 'en' ? 1 : 0);
  return [...yt].sort((a, b) => rank(b) - rank(a) || Math.min(b.size ?? 0, 1080) - Math.min(a.size ?? 0, 1080) || (b.published_at ?? '').localeCompare(a.published_at ?? ''));
}
function pickTrailer(videos: TmdbVideo[] | undefined): string { return rankedTrailers(videos)[0]?.key ?? ''; }

export async function getTrailerCandidates(kind: 'movie' | 'tv', tmdbId: number): Promise<string[]> {
  const data = await request<{ results?: TmdbVideo[] }>(`/${kind}/${tmdbId}/videos`);
  return [...new Set(rankedTrailers(data.results).map((v) => v.key))];
}

/** Rating, collection and trailer for a movie already in the library (one request). */
export async function getMovieExtras(tmdbId: number): Promise<MovieExtras> {
  const d = await request<TmdbMovie>(`/movie/${tmdbId}`, { append_to_response: 'release_dates,videos,keywords' });
  return movieExtras(d);
}

function seriesExtras(d: TmdbTv): SeriesExtras {
  const next = d.next_episode_to_air;
  return {
    certification: d.content_ratings?.results?.find((r) => r.iso_3166_1 === 'US')?.rating ?? '',
    trailer_key: pickTrailer(d.videos?.results),
    tmdb_status: d.status ?? null,
    next_episode:
      next && next.air_date
        ? { season: next.season_number, episode: next.episode_number, name: next.name, air_date: next.air_date }
        : null,
  };
}

/** Rating, trailer, status and next airing for a show already in the library. */
export async function getSeriesExtras(tmdbId: number): Promise<SeriesExtras> {
  const d = await request<TmdbTv>(`/tv/${tmdbId}`, { append_to_response: 'content_ratings,videos' });
  return seriesExtras(d);
}

export interface TmdbCollection {
  id: number;
  name: string;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  parts: CollectionPart[];
}

export async function getCollection(id: number): Promise<TmdbCollection> {
  const d = await request<{
    id: number;
    name: string;
    overview?: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
    parts?: { id: number; title: string; release_date?: string; poster_path?: string | null; backdrop_path?: string | null; overview?: string }[];
  }>(`/collection/${id}`);
  const parts = (d.parts ?? [])
    .map((p) => ({
      tmdb_id: p.id,
      title: p.title,
      year: yearOf(p.release_date),
      release_date: p.release_date || null,
      poster: img(p.poster_path, 'w342'),
      backdrop: img(p.backdrop_path, 'w780'),
      overview: p.overview ?? '',
    }))
    .sort((a, b) => (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999'));
  return { id: d.id, name: d.name, overview: d.overview || null, poster_path: img(d.poster_path, 'w500'), backdrop_path: img(d.backdrop_path, 'w1280'), parts };
}

export interface PersonInfo {
  id: number;
  name: string;
  biography: string;
  birthday: string | null;
  place_of_birth: string | null;
  profile: string | null;
  known_for: string | null;
}

/** Person details by id, or by name search for older library entries without ids. */
export async function getPerson(ref: { id?: number; name: string }): Promise<PersonInfo | null> {
  let id = ref.id;
  if (!id) {
    const res = await request<{ results?: { id: number; name: string }[] }>('/search/person', { query: ref.name, include_adult: 'false' });
    id = res.results?.find((r) => r.name.toLowerCase() === ref.name.toLowerCase())?.id ?? res.results?.[0]?.id;
    if (!id) return null;
  }
  const d = await request<{
    id: number;
    name: string;
    biography?: string;
    birthday?: string | null;
    place_of_birth?: string | null;
    profile_path?: string | null;
    known_for_department?: string;
  }>(`/person/${id}`);
  return {
    id: d.id,
    name: d.name,
    biography: d.biography ?? '',
    birthday: d.birthday ?? null,
    place_of_birth: d.place_of_birth ?? null,
    profile: img(d.profile_path, 'w500'),
    known_for: d.known_for_department ?? null,
  };
}

/** IMDb id for a movie or show already in the library (backfill for older rows). */
export async function getImdbId(kind: 'movie' | 'tv', tmdbId: number): Promise<string> {
  try {
    const d = await request<{ imdb_id?: string | null }>(`/${kind}/${tmdbId}/external_ids`);
    return d.imdb_id || '';
  } catch (e) {
    if (e instanceof TmdbError && e.status === 404) return '';
    throw e;
  }
}

// ---------------------------------------------------------------------------
// TV
// ---------------------------------------------------------------------------

interface TvSearchHit {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
}

async function rawSearchTv(query: string, year?: number | null) {
  const data = await request<{ results: TvSearchHit[] }>('/search/tv', {
    query,
    first_air_date_year: year ?? undefined,
    include_adult: 'false',
  });
  return data.results ?? [];
}

export async function findSeries(title: string, year: number | null): Promise<number | null> {
  let results = await rawSearchTv(title, year);
  if (!results.length && year != null) results = await rawSearchTv(title);
  const best = pickBest(results, title, year, (r) => [r.name, r.original_name ?? ''], (r) => yearOf(r.first_air_date));
  return best?.id ?? null;
}

export async function getSeriesDetails(tmdbId: number): Promise<SeriesMetadata> {
  const d = await request<TmdbTv>(`/tv/${tmdbId}`, {
    append_to_response: 'credits,images,external_ids,content_ratings,videos',
    include_image_language: 'en,null',
  });
  return {
    tmdb_id: d.id,
    title: d.name,
    year: yearOf(d.first_air_date),
    overview: d.overview || null,
    vote_average: d.vote_average ?? null,
    genres: (d.genres ?? []).map((g) => g.name),
    cast_crew: castFrom(d.credits, d.created_by),
    poster_path: img(d.poster_path, 'w500'),
    backdrop_path: img(d.backdrop_path, 'w1280'),
    logo_path: pickLogo(d.images?.logos),
    number_of_seasons: d.number_of_seasons ?? 1,
    imdb_id: d.external_ids?.imdb_id || '',
    extras: seriesExtras(d),
  };
}

function toEpisodeMeta(e: TmdbEpisode): EpisodeMetadata {
  return {
    tmdb_episode_id: e.id,
    season_number: e.season_number,
    episode_number: e.episode_number,
    title: e.name || `Episode ${e.episode_number}`,
    overview: e.overview || null,
    still_path: img(e.still_path, 'w500'),
    air_date: e.air_date || null,
    runtime: e.runtime || null,
  };
}

/**
 * Whole-season lookup. The scanner uses this (cached per season) so a 10-episode season costs
 * one request instead of ten; the payload carries the same fields as the per-episode endpoint.
 */
export async function getSeasonEpisodes(tvId: number, season: number): Promise<Map<number, EpisodeMetadata>> {
  const map = new Map<number, EpisodeMetadata>();
  try {
    const data = await request<{ episodes?: TmdbEpisode[] }>(`/tv/${tvId}/season/${season}`);
    for (const e of data.episodes ?? []) map.set(e.episode_number, toEpisodeMeta(e));
    // Keep the full season list for "missing" and "upcoming" episodes on the show page.
    await saveSeasonCache(
      tvId,
      season,
      [...map.values()].map((e) => ({
        episode_number: e.episode_number,
        name: e.title,
        overview: e.overview,
        still_path: e.still_path,
        air_date: e.air_date,
        runtime: e.runtime,
      })),
    ).catch(() => {});
  } catch (e) {
    if (!(e instanceof TmdbError && e.status === 404)) throw e;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Interactive search (Fix Match)
// ---------------------------------------------------------------------------

export async function searchTitles(kind: 'movie' | 'tv', query: string, year: number | null): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  if (kind === 'movie') {
    const results = await rawSearchMovie(query.trim(), year);
    return results.slice(0, 8).map((r) => ({
      id: r.id,
      kind,
      title: r.title,
      year: yearOf(r.release_date),
      overview: r.overview ?? '',
      poster: img(r.poster_path, 'w185'),
      backdrop: img(r.backdrop_path, 'w780'),
      voteAverage: r.vote_average ?? 0,
    }));
  }
  const results = await rawSearchTv(query.trim(), year);
  return results.slice(0, 8).map((r) => ({
    id: r.id,
    kind,
    title: r.name,
    year: yearOf(r.first_air_date),
    overview: r.overview ?? '',
    poster: img(r.poster_path, 'w185'),
    backdrop: img(r.backdrop_path, 'w780'),
    voteAverage: r.vote_average ?? 0,
  }));
}

// Discovery uses TMDB's lists, independently of the local library.
export type CatalogList = 'trending' | 'popular' | 'new' | 'top';
interface CatalogHit extends MovieSearchHit, Partial<Omit<TvSearchHit, 'id'>> { adult?: boolean }
export async function getCatalog(kind: 'movie' | 'tv', list: CatalogList, page = 1, query = '') {
  const path = query.trim() ? `/search/${kind}` : list === 'trending' ? `/trending/${kind}/week`
    : `/${kind}/${list === 'new' ? (kind === 'movie' ? 'now_playing' : 'on_the_air') : list === 'top' ? 'top_rated' : 'popular'}`;
  const data = await request<{ results?: CatalogHit[]; total_pages?: number }>(path, {
    page, query: query.trim() || undefined, include_adult: 'false', language: 'en-US', region: 'US',
  });
  return {
    pages: Math.min(500, data.total_pages ?? 1),
    items: (data.results ?? []).filter((r) => !r.adult).map((r): SearchResult => ({
      id: r.id, kind, title: (kind === 'movie' ? r.title : r.name) || 'Untitled',
      year: yearOf(kind === 'movie' ? r.release_date : r.first_air_date), overview: r.overview ?? '',
      releaseDate: (kind === 'movie' ? r.release_date : r.first_air_date) || null,
      poster: img(r.poster_path, 'w342'), backdrop: img(r.backdrop_path, 'w1280'), voteAverage: r.vote_average ?? 0,
    })),
  };
}

const catalogDetails = new Map<string, { detail: CatalogDetail; fetchedAt: number }>();
const pendingCatalogDetails = new Map<string, Promise<CatalogDetail>>();

export function getCatalogDetail(item: SearchResult): Promise<CatalogDetail> {
  const key = JSON.stringify([apiKey, item.kind, item.id]);
  const saved = catalogDetails.get(key);
  if (saved && Date.now() - saved.fetchedAt < 15 * 60_000) return Promise.resolve(saved.detail);
  const pending = pendingCatalogDetails.get(key);
  if (pending) return pending;

  const result = loadCatalogDetail(item).then((detail) => {
    catalogDetails.set(key, { detail, fetchedAt: Date.now() });
    if (catalogDetails.size > 60) catalogDetails.delete(catalogDetails.keys().next().value!);
    return detail;
  }).finally(() => pendingCatalogDetails.delete(key));
  pendingCatalogDetails.set(key, result);
  return result;
}

async function loadCatalogDetail(item: SearchResult): Promise<CatalogDetail> {
  if (item.kind === 'movie') {
    const d = await request<TmdbMovie>(`/movie/${item.id}`, { append_to_response: 'credits,images,release_dates', include_image_language: 'en,null' });
    return { ...item, title: d.title, year: yearOf(d.release_date), overview: d.overview ?? '',
      poster: img(d.poster_path, 'w500'), backdrop: img(d.backdrop_path, 'w1280'), voteAverage: d.vote_average ?? item.voteAverage,
      imdbId: d.imdb_id ?? '', certification: movieExtras(d).certification, genres: (d.genres ?? []).map((g) => g.name), runtime: d.runtime || null,
      logo: pickLogo(d.images?.logos), tagline: d.tagline ?? '', cast: castFrom(d.credits), language: d.original_language ?? '', releaseDate: d.release_date ?? null,
      seasons: [], status: d.status ?? '', nextSeason: null, lastSeason: null, lastEpisode: null };
  }
  const d = await request<TmdbTv>(`/tv/${item.id}`, { append_to_response: 'external_ids,content_ratings,credits,images', include_image_language: 'en,null' });
  return { ...item, title: d.name, year: yearOf(d.first_air_date), overview: d.overview ?? '',
    poster: img(d.poster_path, 'w500'), backdrop: img(d.backdrop_path, 'w1280'), voteAverage: d.vote_average ?? item.voteAverage,
    imdbId: d.external_ids?.imdb_id ?? '', certification: seriesExtras(d).certification,
    genres: (d.genres ?? []).map((g) => g.name), runtime: d.episode_run_time?.[0] || null, status: d.status ?? '',
    logo: pickLogo(d.images?.logos), tagline: d.tagline ?? '', cast: castFrom(d.credits, d.created_by), language: d.original_language ?? '',
    releaseDate: d.first_air_date ?? null, totalEpisodes: d.number_of_episodes, networks: (d.networks ?? []).map((n) => n.name),
    seasons: (d.seasons ?? []).filter((s) => s.season_number > 0).map((s) => ({
      number: s.season_number, name: s.name, count: s.episode_count, airDate: s.air_date ?? null,
    })), nextSeason: d.next_episode_to_air?.season_number ?? null,
    lastSeason: d.last_episode_to_air?.season_number ?? null, lastEpisode: d.last_episode_to_air?.episode_number ?? null };
}

export async function getCatalogSeason(detail: CatalogDetail, season: number): Promise<CatalogSeason> {
  const episodes = [...(await getSeasonEpisodes(detail.id, season)).values()].sort((a, b) => a.episode_number - b.episode_number);
  const declared = detail.seasons.find((s) => s.number === season)?.count ?? 0;
  // An aired list alone cannot establish that an ongoing season has finished.
  const closed = ['Ended', 'Canceled'].includes(detail.status)
    || (detail.nextSeason != null && detail.nextSeason > season)
    || (detail.lastSeason != null && detail.lastSeason > season);
  const today = new Date().toISOString().slice(0, 10);
  const complete = closed && declared > 0 && episodes.length === declared
    && episodes.every((e) => !!e.air_date && e.air_date < today)
    && new Set(episodes.map((e) => e.episode_number)).size === declared;
  return { episodes, complete };
}
