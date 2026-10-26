import type { CastMember } from '../types/media';
import type { EpisodeMetadata, MovieMetadata, SeriesMetadata } from './db';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

export const img = (path: string | null | undefined, size: 'w92' | 'w185' | 'w300' | 'w500' | 'w780' | 'w1280' | 'original') =>
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
  cast?: { name: string; character?: string; profile_path?: string | null; order?: number }[];
  crew?: { name: string; job?: string; profile_path?: string | null }[];
}
interface TmdbMovie {
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
}
interface TmdbTv {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  vote_average?: number;
  number_of_seasons?: number;
  genres?: { name: string }[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  created_by?: { name: string; profile_path?: string | null }[];
  credits?: TmdbCredits;
  images?: { logos?: TmdbImage[] };
  external_ids?: { imdb_id?: string | null };
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
    name: c.name,
    character: c.character,
    profile_path: img(c.profile_path, 'w185'),
  }));
  const directors = (credits?.crew ?? [])
    .filter((c) => c.job === 'Director')
    .slice(0, 2)
    .map((c) => ({ name: c.name, job: 'Director', profile_path: img(c.profile_path, 'w185') }));
  const creatorList = creators.slice(0, 2).map((c) => ({ name: c.name, job: 'Creator', profile_path: img(c.profile_path, 'w185') }));
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
    append_to_response: 'credits,images',
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
    backdrop_path: img(d.backdrop_path, 'original'),
    logo_path: pickLogo(d.images?.logos),
    imdb_id: d.imdb_id || '',
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
    append_to_response: 'credits,images,external_ids',
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
    backdrop_path: img(d.backdrop_path, 'original'),
    logo_path: pickLogo(d.images?.logos),
    number_of_seasons: d.number_of_seasons ?? 1,
    imdb_id: d.external_ids?.imdb_id || '',
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

/** Single-episode lookup: GET /tv/{id}/season/{s}/episode/{e}. */
export async function getEpisodeDetails(tvId: number, season: number, episode: number): Promise<EpisodeMetadata | null> {
  try {
    return toEpisodeMeta(await request<TmdbEpisode>(`/tv/${tvId}/season/${season}/episode/${episode}`));
  } catch (e) {
    if (e instanceof TmdbError && e.status === 404) return null;
    throw e;
  }
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
