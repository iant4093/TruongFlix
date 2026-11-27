import type { WatchLogRow } from '../types/media';
import { genreBuckets } from '../store/selectors';
import { nameKey, primaryArtist } from '../music/match';
import type { MusicPlayRow } from './musicdb';

export interface WrappedStats {
  year: number;
  seconds: number;
  days: number;
  movies: number;
  episodes: number;
  shows: number;
  topGenres: { name: string; seconds: number }[];
  topShows: { id: number; title: string; poster: string | null; seconds: number; episodes: number }[];
  topMovies: { id: number; title: string; poster: string | null; seconds: number }[];
  /** Most episodes of one show watched in a single day. */
  binge: { title: string; poster: string | null; episodes: number; day: string } | null;
  longestStreak: { days: number; from: string; to: string } | null;
  months: number[]; // seconds per month
  weekdays: number[]; // seconds per weekday (0 = Sunday)
  busiestDay: { day: string; seconds: number } | null;
}

const parseGenres = (json: string | null): string[] => {
  try {
    return json ? (JSON.parse(json) as string[]) : [];
  } catch {
    return [];
  }
};

const dayDate = (day: string) => new Date(`${day}T12:00:00`);

export interface Streak {
  days: number;
  from: string;
  to: string;
}

/** Longest run of consecutive calendar days (YYYY-MM-DD), or null when there are none. */
export function longestRun(dayList: Iterable<string>): Streak | null {
  const days = [...new Set(dayList)].sort();
  let longest: Streak | null = null;
  let runStart = 0;
  for (let i = 1; i <= days.length; i++) {
    const contiguous = i < days.length && (dayDate(days[i]).getTime() - dayDate(days[i - 1]).getTime()) / 864e5 < 1.5;
    if (!contiguous) {
      const len = i - runStart;
      if (len > 0 && (!longest || len > longest.days)) longest = { days: len, from: days[runStart], to: days[i - 1] };
      runStart = i;
    }
  }
  return longest;
}

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

/** Morning 5–12, afternoon 12–17, evening 17–22, night 22–5 (local time). */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** When most of the time went, with its share of the total; null with fewer than `min` entries. */
function topDayPart(entries: { hour: number; seconds: number }[], min = 3): { part: DayPart; share: number } | null {
  if (entries.length < min) return null;
  const parts = new Map<DayPart, number>();
  let total = 0;
  for (const e of entries) {
    const part = dayPart(e.hour);
    parts.set(part, (parts.get(part) ?? 0) + e.seconds);
    total += e.seconds;
  }
  const [part, secs] = [...parts.entries()].sort((a, b) => b[1] - a[1])[0];
  return total > 0 ? { part, share: secs / total } : null;
}

/** Month-by-month seconds, or null when fewer than two months have any (a one-bar chart says nothing). */
function monthsOrNull(months: number[]): number[] | null {
  return months.filter((m) => m > 0).length >= 2 ? months : null;
}

/** Genre tags like "Indie; Folk" or "Rock, Pop" count towards each genre. */
function addGenres(into: Map<string, { name: string; seconds: number }>, names: Iterable<string>, seconds: number) {
  for (const name of new Set([...names].map((g) => g.trim()).filter(Boolean))) {
    const k = name.toLocaleLowerCase();
    const e = into.get(k) ?? { name, seconds: 0 };
    // "indie" and "Indie" are one genre, shown capitalised when any tag is.
    if (e.name === k && name !== k) e.name = name;
    e.seconds += seconds;
    into.set(k, e);
  }
}

const rankGenres = (genres: Map<string, { name: string; seconds: number }>, top: number) =>
  [...genres.values()].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name)).slice(0, top);

export const logYears = (log: WatchLogRow[]) => [...new Set(log.map((r) => Number(r.day.slice(0, 4))))].sort((a, b) => b - a);

export function computeWrapped(log: WatchLogRow[], year: number): WrappedStats {
  const rows = log.filter((r) => r.day.startsWith(`${year}-`) && r.seconds >= 1);
  const genres = new Map<string, number>();
  const shows = new Map<number, WrappedStats['topShows'][number]>();
  const movies = new Map<number, WrappedStats['topMovies'][number]>();
  const perDay = new Map<string, number>();
  const bingeKey = new Map<string, { title: string; poster: string | null; episodes: number; day: string }>();
  const months = Array<number>(12).fill(0);
  const weekdays = Array<number>(7).fill(0);
  const episodeIds = new Set<number>();
  let seconds = 0;

  for (const r of rows) {
    seconds += r.seconds;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.seconds);
    const d = dayDate(r.day);
    months[d.getMonth()] += r.seconds;
    weekdays[d.getDay()] += r.seconds;
    for (const g of genreBuckets(parseGenres(r.genres))) genres.set(g, (genres.get(g) ?? 0) + r.seconds);
    if (r.media_type === 'movie') {
      const m = movies.get(r.media_id) ?? { id: r.media_id, title: r.title ?? 'Unknown', poster: r.poster, seconds: 0 };
      m.seconds += r.seconds;
      movies.set(r.media_id, m);
    } else if (r.series_id != null) {
      const s = shows.get(r.series_id) ?? { id: r.series_id, title: r.series_title ?? 'Unknown', poster: r.poster, seconds: 0, episodes: 0 };
      s.seconds += r.seconds;
      if (!episodeIds.has(r.media_id)) s.episodes += 1;
      episodeIds.add(r.media_id);
      shows.set(r.series_id, s);
      // Only episodes watched for a meaningful stretch count towards a binge.
      if (r.seconds >= 300) {
        const key = `${r.series_id}|${r.day}`;
        const b = bingeKey.get(key) ?? { title: r.series_title ?? 'Unknown', poster: r.poster, episodes: 0, day: r.day };
        b.episodes += 1;
        bingeKey.set(key, b);
      }
    }
  }

  // Longest run of consecutive days with anything watched.
  const longest = longestRun(perDay.keys());

  const binge = [...bingeKey.values()].sort((a, b) => b.episodes - a.episodes)[0] ?? null;
  const busiest = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const movieIds = new Set(rows.filter((r) => r.media_type === 'movie').map((r) => r.media_id));

  return {
    year,
    seconds,
    days: perDay.size,
    movies: movieIds.size,
    episodes: episodeIds.size,
    shows: shows.size,
    topGenres: [...genres.entries()].map(([name, s]) => ({ name, seconds: s })).sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    topShows: [...shows.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    topMovies: [...movies.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    binge: binge && binge.episodes >= 2 ? binge : null,
    longestStreak: longest,
    months,
    weekdays,
    busiestDay: busiest ? { day: busiest[0], seconds: busiest[1] } : null,
  };
}

// ---------------------------------------------------------------------------
// Games (Windows): play sessions recorded on this PC
// ---------------------------------------------------------------------------

/** A recorded game session (mirrors the games library's PlaySession). */
export interface GameSessionRow {
  slug: string;
  title: string;
  cover: string | null;
  startedAt: string;
  seconds: number;
  /** Rebuilt from older totals: counts towards the year, but its day and length aren't real. */
  estimated: boolean;
  /** Who played; null for sessions recorded before that was noted. */
  profileId?: number | null;
  genres?: string[];
}

/** Sessions that belong to this profile: its own, plus ones recorded before sessions noted who played. */
export const profileSessions = (sessions: GameSessionRow[], profileId: number) =>
  sessions.filter((s) => s.profileId == null || s.profileId === profileId);

export interface GameWrappedStats {
  seconds: number;
  sessions: number;
  games: number;
  /** Days with a recorded session. */
  days: number;
  topGames: { slug: string; title: string; cover: string | null; seconds: number; sessions: number }[];
  longestSession: { title: string; cover: string | null; seconds: number; day: string } | null;
  /** Day with the most play time, when it adds up to more than the longest session. */
  busiestDay: { day: string; seconds: number } | null;
  /** Average recorded session, with at least two of them. */
  averageSession: number | null;
  /** Two or more days in a row. */
  longestStreak: Streak | null;
  topGenres: { name: string; seconds: number }[];
  /** When most play time started, with three or more recorded sessions. */
  timeOfDay: { part: DayPart; share: number } | null;
  /** Seconds per month, when at least two months have play time. */
  months: number[] | null;
  /** Includes time recorded before sessions noted who played (shown as "on this PC"). */
  shared: boolean;
}

/** Local calendar day (YYYY-MM-DD) of an ISO time. */
export function localDay(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const sessionYears = (sessions: GameSessionRow[]) =>
  [...new Set(sessions.filter((s) => s.seconds > 0).map((s) => Number(localDay(s.startedAt)?.slice(0, 4))).filter((y) => y > 0))].sort((a, b) => b - a);

/** Yearly game stats, or null when less than a minute was played that year. */
export function computeGameWrapped(sessions: GameSessionRow[], year: number, top = 5): GameWrappedStats | null {
  const games = new Map<string, GameWrappedStats['topGames'][number] & { last: string }>();
  const perDay = new Map<string, number>();
  const genres = new Map<string, { name: string; seconds: number }>();
  const months = Array<number>(12).fill(0);
  const starts: { hour: number; seconds: number }[] = [];
  let seconds = 0;
  let count = 0;
  let recorded = 0;
  let shared = false;
  let longest: GameWrappedStats['longestSession'] = null;

  for (const s of sessions) {
    const day = localDay(s.startedAt);
    if (!day || !day.startsWith(`${year}-`) || !(s.seconds > 0)) continue;
    seconds += s.seconds;
    const g = games.get(s.slug) ?? { slug: s.slug, title: s.title, cover: s.cover, seconds: 0, sessions: 0, last: '' };
    g.seconds += s.seconds;
    // Title and cover follow the most recent session, in case the entry was re-added.
    if (s.startedAt >= g.last) Object.assign(g, { title: s.title, cover: s.cover ?? g.cover, last: s.startedAt });
    if (s.profileId == null) shared = true;
    addGenres(genres, s.genres ?? [], s.seconds);
    if (!s.estimated) {
      g.sessions += 1;
      count += 1;
      recorded += s.seconds;
      perDay.set(day, (perDay.get(day) ?? 0) + s.seconds);
      months[Number(day.slice(5, 7)) - 1] += s.seconds;
      starts.push({ hour: new Date(s.startedAt).getHours(), seconds: s.seconds });
      if (!longest || s.seconds > longest.seconds) longest = { title: s.title, cover: s.cover, seconds: s.seconds, day };
    }
    games.set(s.slug, g);
  }
  if (seconds < 60) return null;

  const busiest = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const streak = longestRun(perDay.keys());
  return {
    seconds,
    sessions: count,
    games: games.size,
    days: perDay.size,
    topGames: [...games.values()]
      .sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title))
      .slice(0, top)
      .map((g) => ({ slug: g.slug, title: g.title, cover: g.cover, seconds: g.seconds, sessions: g.sessions })),
    longestSession: longest,
    // A day that was only its longest session would repeat that card.
    busiestDay: busiest && busiest[1] > (longest?.seconds ?? 0) ? { day: busiest[0], seconds: busiest[1] } : null,
    averageSession: count >= 2 && recorded / count >= 60 ? recorded / count : null,
    longestStreak: streak && streak.days >= 2 ? streak : null,
    topGenres: rankGenres(genres, top),
    timeOfDay: topDayPart(starts),
    months: monthsOrNull(months),
    shared,
  };
}

// ---------------------------------------------------------------------------
// Music: this profile's plays
// ---------------------------------------------------------------------------

export interface MusicWrappedStats {
  /** Listening time (plays without a recorded time count as the song's length). */
  seconds: number;
  plays: number;
  songs: number;
  artists: number;
  albums: number;
  days: number;
  topSongs: { id: number; title: string; artist: string; art: string | null; plays: number; seconds: number }[];
  topArtists: { key: string; name: string; art: string | null; plays: number; seconds: number; songs: number }[];
  topAlbums: { id: number; title: string; artist: string; art: string | null; plays: number; seconds: number }[];
  topGenres: { name: string; seconds: number }[];
  /** Two or more days in a row. */
  longestStreak: Streak | null;
  /** Day with the most listening, when music was played on more than one day. */
  busiestDay: { day: string; seconds: number; plays: number } | null;
  /** One song played three or more times in a day. */
  onRepeat: { title: string; artist: string; art: string | null; plays: number; day: string } | null;
  /** When most listening happened, with three or more plays. */
  timeOfDay: { part: DayPart; share: number } | null;
  /** First song of the year, when more than one song was played. */
  firstSong: { title: string; artist: string; art: string | null; day: string } | null;
  /** Seconds per month, when at least two months have listening. */
  months: number[] | null;
}

const localDayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const splitGenres = (genre: string | null) => (genre ?? '').split(/[;,\u0000]/);

export const playYears = (plays: Pick<MusicPlayRow, 'playedAt'>[]) =>
  [...new Set(plays.filter((p) => Number.isFinite(p.playedAt)).map((p) => new Date(p.playedAt).getFullYear()))].sort((a, b) => b - a);

/** Yearly music stats, or null when less than a minute was listened to that year. */
export function computeMusicWrapped(plays: MusicPlayRow[], year: number, top = 5): MusicWrappedStats | null {
  const rows = plays
    .filter((p) => Number.isFinite(p.playedAt) && new Date(p.playedAt).getFullYear() === year)
    .map((p) => ({ ...p, listened: Math.max(0, p.seconds ?? p.duration ?? 0), day: localDayOf(p.playedAt) }))
    .sort((a, b) => a.playedAt - b.playedAt);
  const seconds = rows.reduce((n, r) => n + r.listened, 0);
  if (!rows.length || seconds < 60) return null;

  type ArtistAcc = MusicWrappedStats['topArtists'][number] & { ids: Set<number>; covers: Map<string, number> };
  const songs = new Map<number, MusicWrappedStats['topSongs'][number]>();
  const artists = new Map<string, ArtistAcc>();
  const albums = new Map<number, MusicWrappedStats['topAlbums'][number]>();
  const genres = new Map<string, { name: string; seconds: number }>();
  const perDay = new Map<string, { seconds: number; plays: number }>();
  const repeats = new Map<string, NonNullable<MusicWrappedStats['onRepeat']>>();
  const months = Array<number>(12).fill(0);

  for (const r of rows) {
    const song = songs.get(r.trackId) ?? { id: r.trackId, title: r.title, artist: r.artist, art: r.art, plays: 0, seconds: 0 };
    song.plays += 1;
    song.seconds += r.listened;
    songs.set(r.trackId, song);

    // "Artist feat. Guest" counts towards Artist.
    const name = primaryArtist(r.artist) || r.artist;
    const ak = nameKey(name) || name.toLocaleLowerCase();
    const artist: ArtistAcc = artists.get(ak) ?? { key: ak, name, art: null, plays: 0, seconds: 0, songs: 0, ids: new Set(), covers: new Map() };
    artist.plays += 1;
    artist.seconds += r.listened;
    artist.ids.add(r.trackId);
    if (r.art) artist.covers.set(r.art, (artist.covers.get(r.art) ?? 0) + 1);
    artists.set(ak, artist);

    const album = albums.get(r.albumId) ?? { id: r.albumId, title: r.album, artist: r.albumArtist, art: r.art, plays: 0, seconds: 0 };
    album.plays += 1;
    album.seconds += r.listened;
    album.art ??= r.art;
    albums.set(r.albumId, album);

    addGenres(genres, splitGenres(r.genre), r.listened);

    const d = perDay.get(r.day) ?? { seconds: 0, plays: 0 };
    d.seconds += r.listened;
    d.plays += 1;
    perDay.set(r.day, d);
    months[new Date(r.playedAt).getMonth()] += r.listened;

    const rk = `${r.trackId}|${r.day}`;
    const again = repeats.get(rk) ?? { title: r.title, artist: r.artist, art: r.art, plays: 0, day: r.day };
    again.plays += 1;
    repeats.set(rk, again);
  }

  const byPlays = <T extends { plays: number; seconds: number }>(a: T, b: T) => b.plays - a.plays || b.seconds - a.seconds;
  const busiest = [...perDay.entries()].sort((a, b) => b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]))[0];
  const onRepeat = [...repeats.values()].sort((a, b) => b.plays - a.plays || a.day.localeCompare(b.day))[0];
  const streak = longestRun(perDay.keys());
  const first = rows[0];

  return {
    seconds,
    plays: rows.length,
    songs: songs.size,
    artists: artists.size,
    albums: albums.size,
    days: perDay.size,
    topSongs: [...songs.values()].sort(byPlays).slice(0, top),
    topArtists: [...artists.values()]
      .sort((a, b) => b.seconds - a.seconds || b.plays - a.plays || a.name.localeCompare(b.name))
      .slice(0, top)
      .map(({ ids, covers, ...a }) => ({ ...a, songs: ids.size, art: [...covers.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null })),
    topAlbums: [...albums.values()].sort(byPlays).slice(0, top),
    topGenres: rankGenres(genres, top),
    longestStreak: streak && streak.days >= 2 ? streak : null,
    busiestDay: busiest && perDay.size >= 2 ? { day: busiest[0], ...busiest[1] } : null,
    onRepeat: onRepeat && onRepeat.plays >= 3 ? onRepeat : null,
    timeOfDay: topDayPart(rows.map((r) => ({ hour: new Date(r.playedAt).getHours(), seconds: r.listened }))),
    firstSong: songs.size >= 2 ? { title: first.title, artist: first.artist, art: first.art, day: first.day } : null,
    months: monthsOrNull(months),
  };
}

/** Whole minutes, for music ("1,234"). */
export const formatMinutes = (seconds: number) => Math.round(seconds / 60).toLocaleString();

export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  if (h >= 10) return `${Math.round(h).toLocaleString()}`;
  if (h >= 1) return h.toFixed(1);
  return `${Math.round(seconds / 60)}m`;
}
