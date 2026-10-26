import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { useLibraryStore } from '../store/useLibraryStore';
import type { SeasonRating } from '../types/media';
import * as db from './db';
import { getImdbId } from './tmdb';

interface Lookup {
  ratings: Record<string, { rating: number; votes: number }>;
  episodes: { tconst: string; parent: string; season: number; episode: number }[];
  updated: number;
}

export const imdbUrl = (imdbId: string) => `https://www.imdb.com/title/${imdbId}/`;
export const openImdb = (imdbId: string) => openExternal(imdbUrl(imdbId));

export function formatVotes(votes: number | null | undefined): string {
  if (!votes) return '';
  if (votes >= 1e6) return `${(votes / 1e6).toFixed(votes >= 1e7 ? 0 : 1)}M`;
  if (votes >= 1e3) return `${Math.round(votes / 1e3)}K`;
  return String(votes);
}

const SYNC_INTERVAL_MS = 20 * 3600 * 1000;

/** True when ratings are stale or some titles were never looked up. */
export function imdbSyncDue(): boolean {
  const { settings, movies, series } = useLibraryStore.getState();
  if (!settings.imdb_enabled) return false;
  const last = Date.parse(settings.imdb_last_sync || '');
  if (!last || Date.now() - last > SYNC_INTERVAL_MS) return true;
  return movies.some((m) => m.tmdb_id && m.imdb_id == null) || series.some((s) => s.tmdb_id > 0 && s.imdb_id == null);
}

/**
 * Refreshes IMDb ratings for every movie, show, season and episode in the library.
 * 1) resolves missing IMDb ids via TMDB, 2) filters IMDb's public datasets in Rust,
 * 3) writes only values that changed.
 */
export async function syncImdbRatings(opts: { force?: boolean; onProgress?: (message: string) => void } = {}) {
  const store = useLibraryStore.getState();
  if (!store.settings.imdb_enabled) return;
  const report = opts.onProgress ?? (() => {});
  const unlisten = await listen<{ message: string }>('imdb-progress', (e) => report(e.payload.message));

  try {
    // 1. Backfill IMDb ids for titles scanned before this feature existed.
    report('Linking titles to IMDb…');
    const movieTmdb = [...new Set(store.movies.filter((m) => m.tmdb_id && m.imdb_id == null).map((m) => m.tmdb_id!))];
    for (const id of movieTmdb) await db.setImdbId('movies', id, await getImdbId('movie', id));
    for (const s of store.series.filter((x) => x.tmdb_id > 0 && x.imdb_id == null)) {
      await db.setImdbId('tv_series', s.tmdb_id, await getImdbId('tv', s.tmdb_id));
    }
    const { movies, series, episodes } = await db.loadLibrary();

    const movieIds = [...new Set(movies.map((m) => m.imdb_id).filter((x): x is string => !!x))];
    const showIds = [...new Set(series.map((s) => s.imdb_id).filter((x): x is string => !!x))];
    if (!movieIds.length && !showIds.length) return;

    // 2. Look everything up in one pass over the datasets.
    const res = await invoke<Lookup>('imdb_lookup', { titleIds: [...movieIds, ...showIds], showIds, force: !!opts.force });
    report('Saving IMDb ratings…');

    // 3. Write back (only changed values).
    for (const m of movies) {
      const r = m.imdb_id ? res.ratings[m.imdb_id] : undefined;
      if (m.imdb_id && (r?.rating ?? null) !== m.imdb_rating) {
        await db.setTitleImdbRating('movies', m.imdb_id, r?.rating ?? null, r?.votes ?? null);
      }
    }

    const byShow = new Map<string, Lookup['episodes']>();
    for (const e of res.episodes) byShow.set(e.parent, [...(byShow.get(e.parent) ?? []), e]);

    for (const s of series) {
      if (!s.imdb_id) continue;
      const r = res.ratings[s.imdb_id];
      if ((r?.rating ?? null) !== s.imdb_rating) await db.setTitleImdbRating('tv_series', s.imdb_id, r?.rating ?? null, r?.votes ?? null);

      // Season averages use every rated episode of the season, not just the ones on disk.
      const showEps = byShow.get(s.imdb_id) ?? [];
      const seasons: Record<number, SeasonRating> = {};
      const sums = new Map<number, { total: number; count: number }>();
      for (const e of showEps) {
        const er = res.ratings[e.tconst];
        if (!er) continue;
        const acc = sums.get(e.season) ?? { total: 0, count: 0 };
        acc.total += er.rating;
        acc.count += 1;
        sums.set(e.season, acc);
      }
      for (const [season, { total, count }] of sums) seasons[season] = { rating: Math.round((total / count) * 10) / 10, count };
      const json = JSON.stringify(seasons);
      if (json !== (s.imdb_season_ratings ?? '{}')) await db.setSeasonRatings(s.id, seasons);

      const lookup = new Map(showEps.map((e) => [`${e.season}x${e.episode}`, e.tconst]));
      for (const ep of episodes.filter((e) => e.series_id === s.id)) {
        const tconst = lookup.get(`${ep.season_number}x${ep.episode_number}`) ?? null;
        const er = tconst ? res.ratings[tconst] : undefined;
        if (tconst !== ep.imdb_id || (er?.rating ?? null) !== ep.imdb_rating) {
          await db.setEpisodeImdb(ep.id, tconst, er?.rating ?? null, er?.votes ?? null);
        }
      }
    }

    await store.updateSettings({ imdb_last_sync: new Date().toISOString() });
  } finally {
    unlisten();
    await useLibraryStore.getState().reload();
  }
}
