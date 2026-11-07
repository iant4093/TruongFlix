import type { NextEpisode } from '../types/media';

/**
 * Episode release dates from TVmaze (free, keyless), merged with TMDB's. TMDB often lists the
 * linear broadcast date while the streaming release comes days earlier, so each episode uses
 * whichever release is earliest.
 */

const API = 'https://api.tvmaze.com';
const REFRESH_MS = 12 * 3600_000;
const FAILURE_RETRY_MS = 3600_000;
/** A TVmaze date this much earlier than TMDB's most likely belongs to a differently numbered episode. */
const MAX_EARLIER_DAYS = 14;
/** Seasons with nothing newer than this are settled history; TVmaze isn't consulted for them. */
const RECENT_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar date (YYYY-MM-DD) of an instant; `toISOString` would give the UTC date. */
export function localDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A YYYY-MM-DD date as local noon (`new Date('2026-11-13')` is UTC midnight, the 12th in the Americas). */
export function parseLocalDate(date: string): Date {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12);
}

/** Whole calendar days from today to `date` (0 = today, 1 = tomorrow, -1 = yesterday). */
export function daysUntil(date: string, now: Date = new Date()): number {
  return Math.round((parseLocalDate(date).getTime() - parseLocalDate(localDateKey(now)).getTime()) / 864e5);
}

/** "Today", "Tomorrow", a weekday within the coming week, otherwise "Nov 13". */
export function airDayLabel(date: string, now: Date = new Date()): string {
  const days = daysUntil(date, now);
  const d = parseLocalDate(date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface TvmazeEpisode {
  season: number;
  number: number | null;
  name?: string;
  airdate?: string | null;
  airstamp?: string | null;
}

/** The release as a local date: the exact airing instant when known, else the listed date. */
export function tvmazeLocalDate(ep: Pick<TvmazeEpisode, 'airdate' | 'airstamp'>): string | null {
  if (ep.airstamp) {
    const t = new Date(ep.airstamp);
    if (!Number.isNaN(t.getTime())) return localDateKey(t);
  }
  return ep.airdate && /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate) ? ep.airdate : null;
}

/** The earlier of TMDB's and TVmaze's dates (TVmaze is ignored when implausibly far ahead of TMDB). */
export function earliestAirDate(tmdb: string | null | undefined, other: string | null | undefined): string | null {
  if (!tmdb) return other ?? null;
  if (!other || other >= tmdb) return tmdb;
  return daysUntil(tmdb, parseLocalDate(other)) <= MAX_EARLIER_DAYS ? other : tmdb;
}

export interface ScheduleEpisode {
  season: number;
  episode: number;
  name: string;
  date: string;
}

export interface AirSchedule {
  episodes: ScheduleEpisode[];
  byKey: Map<string, ScheduleEpisode>;
}

const key = (season: number, episode: number) => `${season}:${episode}`;

export function buildSchedule(raw: TvmazeEpisode[]): AirSchedule {
  const episodes: ScheduleEpisode[] = [];
  for (const e of raw) {
    const date = tvmazeLocalDate(e);
    if (e.number == null || !date || !(e.season > 0)) continue;
    episodes.push({ season: e.season, episode: e.number, name: e.name ?? '', date });
  }
  return { episodes, byKey: new Map(episodes.map((e) => [key(e.season, e.episode), e])) };
}

/** Applies the earliest release to each episode of one season. */
export function mergeSeasonAirDates<T extends { episode_number: number; air_date: string | null }>(season: number, episodes: T[], schedule: AirSchedule | null): T[] {
  if (!schedule) return episodes;
  return episodes.map((e) => {
    const air_date = earliestAirDate(e.air_date, schedule.byKey.get(key(season, e.episode_number))?.date);
    return air_date === e.air_date ? e : { ...e, air_date };
  });
}

/**
 * The next episode by earliest release. TMDB's pick can already be out on streaming (its date being
 * the later broadcast), in which case the next upcoming episode on TVmaze takes over.
 */
export function mergeNextEpisode(tmdbNext: NextEpisode | null, schedule: AirSchedule | null, today = localDateKey()): NextEpisode | null {
  if (!schedule) return tmdbNext;
  const candidates: NextEpisode[] = [];
  let released: NextEpisode | null = null;
  if (tmdbNext) {
    const date = earliestAirDate(tmdbNext.air_date, schedule.byKey.get(key(tmdbNext.season, tmdbNext.episode))?.date) ?? tmdbNext.air_date;
    const merged = { ...tmdbNext, air_date: date };
    if (date >= today) candidates.push(merged);
    else released = merged;
  }
  const upcoming = schedule.episodes
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.season - b.season || a.episode - b.episode)[0];
  if (upcoming) {
    const same = tmdbNext && tmdbNext.season === upcoming.season && tmdbNext.episode === upcoming.episode;
    candidates.push({
      season: upcoming.season,
      episode: upcoming.episode,
      name: (same ? tmdbNext.name : upcoming.name) || `Episode ${upcoming.episode}`,
      air_date: same ? (earliestAirDate(tmdbNext.air_date, upcoming.date) ?? upcoming.date) : upcoming.date,
    });
  }
  candidates.sort((a, b) => a.air_date.localeCompare(b.air_date) || a.season - b.season || a.episode - b.episode);
  return candidates[0] ?? released;
}

/** Whether a season has episodes recent or unscheduled enough for release dates to matter. */
export function seasonNeedsSchedule(dates: (string | null)[], today = localDateKey()): boolean {
  return dates.some((d) => !d || daysUntil(d, parseLocalDate(today)) >= -RECENT_DAYS);
}

// ---------------------------------------------------------------------------
// TVmaze client (in-memory cache per show, ~20 requests / 10 s allowed)
// ---------------------------------------------------------------------------

export interface ShowIds {
  imdb?: string | null;
  tvdb?: number | null;
}

const cache = new Map<number, { schedule: AirSchedule | null; at: number; ttl: number }>();
const pending = new Map<number, Promise<AirSchedule | null>>();
let queue: Promise<unknown> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requests run one after another with a short gap, staying inside TVmaze's rate limit. */
function tvmaze<T>(path: string): Promise<T | null> {
  const run = queue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(API + path, { headers: { Accept: 'application/json' } });
      await sleep(550);
      if (res.status === 429) {
        await sleep(2000);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`TVmaze ${res.status}`);
      return (await res.json()) as T;
    }
    throw new Error('TVmaze rate limit');
  });
  queue = run.catch(() => {});
  return run;
}

async function loadSchedule(ids: ShowIds): Promise<AirSchedule | null> {
  let show: { id: number } | null = null;
  if (ids.imdb) show = await tvmaze<{ id: number }>(`/lookup/shows?imdb=${encodeURIComponent(ids.imdb)}`);
  if (!show && ids.tvdb) show = await tvmaze<{ id: number }>(`/lookup/shows?thetvdb=${ids.tvdb}`);
  if (!show?.id) return null;
  const episodes = await tvmaze<TvmazeEpisode[]>(`/shows/${show.id}/episodes`);
  return episodes ? buildSchedule(episodes) : null;
}

/** TVmaze's schedule for a TMDB show, or null when it isn't listed or TVmaze can't be reached. */
export function getAirSchedule(tmdbId: number, resolveIds: () => Promise<ShowIds> | ShowIds): Promise<AirSchedule | null> {
  const saved = cache.get(tmdbId);
  if (saved && Date.now() - saved.at < saved.ttl) return Promise.resolve(saved.schedule);
  const inFlight = pending.get(tmdbId);
  if (inFlight) return inFlight;
  const result = (async () => {
    try {
      const schedule = await loadSchedule(await resolveIds());
      cache.set(tmdbId, { schedule, at: Date.now(), ttl: REFRESH_MS });
      return schedule;
    } catch {
      // Keep using an older schedule if there is one; TMDB alone otherwise.
      cache.set(tmdbId, { schedule: saved?.schedule ?? null, at: Date.now(), ttl: FAILURE_RETRY_MS });
      return saved?.schedule ?? null;
    }
  })().finally(() => pending.delete(tmdbId));
  pending.set(tmdbId, result);
  return result;
}

export function clearAirScheduleCache() {
  cache.clear();
}
