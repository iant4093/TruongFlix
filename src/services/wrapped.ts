import type { WatchLogRow } from '../types/media';
import { genreBuckets } from '../store/selectors';

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
  const days = [...perDay.keys()].sort();
  let longest: WrappedStats['longestStreak'] = null;
  let runStart = 0;
  for (let i = 1; i <= days.length; i++) {
    const contiguous = i < days.length && (dayDate(days[i]).getTime() - dayDate(days[i - 1]).getTime()) / 864e5 < 1.5;
    if (!contiguous) {
      const len = i - runStart;
      if (len > 0 && (!longest || len > longest.days)) longest = { days: len, from: days[runStart], to: days[i - 1] };
      runStart = i;
    }
  }

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

export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  if (h >= 10) return `${Math.round(h).toLocaleString()}`;
  if (h >= 1) return h.toFixed(1);
  return `${Math.round(seconds / 60)}m`;
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
