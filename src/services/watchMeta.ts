import { useLibraryStore } from '../store/useLibraryStore';

export interface WatchMeta {
  title: string;
  series_id: number | null;
  series_title: string | null;
  genres: string[];
  season: number | null;
  episode: number | null;
  poster: string | null;
}

/**
 * What the viewing log records for a title. One place for the PC player, the phone and casting:
 * the phone and casts used to log no genres, show or poster, so their viewing was missing from
 * Wrapped's genres, shows and binges (and could wipe a day's genres for the PC's viewing too).
 */
export function watchMeta(type: 'movie' | 'episode', id: number): WatchMeta | null {
  const { movies, episodes, series, items } = useLibraryStore.getState();
  if (type === 'movie') {
    const m = movies.find((x) => x.id === id);
    if (!m) return null;
    const item = items.find((i) => i.kind === 'movie' && i.versions.some((v) => v.id === m.id));
    return { title: m.title, series_id: null, series_title: null, genres: item?.genres ?? [], season: null, episode: null, poster: m.poster_path };
  }
  const e = episodes.find((x) => x.id === id);
  const s = e ? series.find((x) => x.id === e.series_id) : undefined;
  if (!e || !s) return null;
  const item = items.find((i) => i.kind === 'tv' && i.id === s.id);
  return { title: e.title, series_id: s.id, series_title: s.title, genres: item?.genres ?? [], season: e.season_number, episode: e.episode_number, poster: s.poster_path };
}
