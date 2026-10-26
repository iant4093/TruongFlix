import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EpisodeRow, MediaItem, MovieRow, RawVideoFile, TechInfo } from '../types/media';
import * as db from './db';
import type { EpisodeMetadata, FileInfo, MatchHint, MovieMetadata, SeriesMetadata } from './db';
import { organizeLooseFiles } from './files';
import { imdbSyncDue, syncImdbRatings } from './imdb';
import { guessSeasonEpisode, parseVideoFile, toRawFile } from './parser';
import * as tmdb from './tmdb';
import type { SearchResult } from './tmdb';

const CONCURRENCY = 4;
const RELOAD_EVERY = 8;

// ---------------------------------------------------------------------------
// Per-scan caches: 50 episodes of one show hit the series endpoint once.
// ---------------------------------------------------------------------------

interface SeriesRef {
  id: number;
  tmdbId: number;
}

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function syntheticSeriesId(title: string): number {
  let h = 0;
  for (const ch of normKey(title)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return -((Math.abs(h) % 1_000_000_000) + 1);
}

function unmatchedMovie(title: string, year: number | null): MovieMetadata {
  return {
    tmdb_id: null, title, original_title: null, year, overview: null, tagline: null, runtime: null,
    vote_average: null, genres: [], cast_crew: [], poster_path: null, backdrop_path: null, logo_path: null,
    imdb_id: null,
  };
}

function unmatchedSeries(title: string, year: number | null): SeriesMetadata {
  return {
    tmdb_id: syntheticSeriesId(title), title, year, overview: null, vote_average: null, genres: [], cast_crew: [],
    poster_path: null, backdrop_path: null, logo_path: null, number_of_seasons: 1, imdb_id: null,
  };
}

class ScanContext {
  private series = new Map<string, Promise<SeriesRef>>();
  private seasons = new Map<string, Promise<Map<number, EpisodeMetadata>>>();
  private movies = new Map<number, Promise<MovieMetadata>>();

  movieDetails(tmdbId: number) {
    let p = this.movies.get(tmdbId);
    if (!p) {
      p = tmdb.getMovieDetails(tmdbId);
      this.movies.set(tmdbId, p);
      p.catch(() => this.movies.delete(tmdbId));
    }
    return p;
  }

  seriesFor(title: string, year: number | null, folder: string | null, knownTmdbId?: number): Promise<SeriesRef> {
    const key = knownTmdbId ? `id:${knownTmdbId}` : `q:${normKey(title)}|${year ?? ''}`;
    let p = this.series.get(key);
    if (!p) {
      p = (async () => {
        const tmdbId = knownTmdbId ?? (await tmdb.findSeries(title, year));
        const meta = tmdbId ? await tmdb.getSeriesDetails(tmdbId) : unmatchedSeries(title, year);
        const id = await db.upsertSeries(meta, folder);
        return { id, tmdbId: meta.tmdb_id };
      })();
      this.series.set(key, p);
      p.catch(() => this.series.delete(key));
    }
    return p;
  }

  season(tvId: number, season: number) {
    const key = `${tvId}:${season}`;
    let p = this.seasons.get(key);
    if (!p) {
      p = tvId > 0 ? tmdb.getSeasonEpisodes(tvId, season) : Promise.resolve(new Map());
      this.seasons.set(key, p);
      p.catch(() => this.seasons.delete(key));
    }
    return p;
  }

  async episodeMeta(tvId: number, season: number, episodes: number[]): Promise<EpisodeMetadata> {
    const map = await this.season(tvId, season);
    const found = episodes.map((e) => map.get(e)).filter((e): e is EpisodeMetadata => !!e);
    const first = found[0];
    if (!first) {
      return {
        tmdb_episode_id: null, season_number: season, episode_number: episodes[0], overview: null, still_path: null,
        air_date: null, runtime: null,
        title: episodes.length > 1 ? `Episodes ${episodes.join('–')}` : `Episode ${episodes[0]}`,
      };
    }
    if (found.length === 1) return first;
    return {
      ...first,
      title: found.map((e) => e.title).join(' / '),
      runtime: found.reduce((sum, e) => sum + (e.runtime ?? 0), 0) || first.runtime,
    };
  }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

async function ingestFile(file: RawVideoFile, ctx: ScanContext, hint?: MatchHint) {
  const parsed = parseVideoFile(file);
  const info: FileInfo = { file_path: file.file_path, raw_filename: file.filename, file_mtime: file.mtime };
  const kind = hint?.kind ?? parsed.kind;
  const title = parsed.kind === 'movie' ? parsed.title : parsed.showTitle;

  if (kind === 'movie') {
    const tmdbId = hint?.tmdbId ?? (await tmdb.findMovie(title, parsed.year));
    const meta = tmdbId ? await ctx.movieDetails(tmdbId) : unmatchedMovie(title, parsed.year);
    await db.upsertMovie(info, meta, parsed.tech);
    return;
  }

  const season = parsed.kind === 'tv' ? parsed.season : guessSeasonEpisode(file).season;
  const episodes = parsed.kind === 'tv' ? parsed.episodes : [guessSeasonEpisode(file).episode];
  const folder = parsed.kind === 'tv' ? parsed.showFolder : null;
  const series = await ctx.seriesFor(title, parsed.year, folder, hint?.tmdbId);
  const meta = await ctx.episodeMeta(series.tmdbId, season, episodes);
  await db.upsertEpisode(series.id, info, meta, parsed.tech);
}

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let i = 0;
  const run = async () => {
    while (i < items.length) await worker(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

const isUnder = (path: string, root: string) => {
  const r = root.replace(/[\\/]+$/, '');
  return path === r || path.startsWith(r + '/') || path.startsWith(r + '\\');
};

export interface ScanOptions {
  /** Re-fetch metadata for every file, not just new/changed ones. */
  force?: boolean;
}

/** Rust directory walk -> incremental SQLite diff -> parser -> TMDB -> SQLite. */
export async function runScan(opts: ScanOptions = {}) {
  const store = useLibraryStore.getState();
  if (store.scan.running) return;
  const { settings, setScan, toast, reload } = store;
  const dirs = settings.media_directories;

  if (!settings.tmdb_api_key) {
    toast('Add your TMDB API key in Settings before scanning.', 'error');
    return;
  }
  if (!dirs.length) {
    toast('Add at least one media folder in Settings.', 'error');
    return;
  }

  setScan({ running: true, phase: 'walking', current: 0, total: 0, added: 0, removed: 0, message: 'Scanning folders…' });
  try {
    const reachable = await invoke<boolean[]>('check_paths', { paths: dirs });
    const roots = dirs.filter((_, i) => reachable[i]);
    const offline = dirs.filter((_, i) => !reachable[i]);

    // Tidy loose videos into their own folders first (DB paths are updated, so nothing is re-matched).
    let organized = 0;
    if (settings.organize_loose_files && roots.length) {
      setScan({ message: 'Organizing loose files…' });
      try {
        const res = await organizeLooseFiles(roots);
        organized = res.moved;
        if (res.errors.length) console.warn('[scan] organize issues', res.errors);
      } catch (e) {
        console.warn('[scan] organize failed', e);
      }
    }

    const files = roots.length ? await invoke<RawVideoFile[]>('scan_media_folders', { paths: roots }) : [];

    setScan({ phase: 'diffing', message: `Found ${files.length} videos` });
    const [index, hints] = await Promise.all([db.getFileIndex(), db.getMatchHints()]);
    const onDisk = new Set(files.map((f) => f.file_path));

    // Prune rows whose files vanished — but never for roots that are merely offline.
    const goneMovies: string[] = [];
    const goneEpisodes: string[] = [];
    for (const [path, rec] of index) {
      if (onDisk.has(path) || offline.some((r) => isUnder(path, r))) continue;
      (rec.type === 'movie' ? goneMovies : goneEpisodes).push(path);
    }
    const removed = goneMovies.length + goneEpisodes.length;
    if (removed) await db.deleteMediaPaths(goneMovies, goneEpisodes);

    const todo = files.filter((f) => {
      const rec = index.get(f.file_path);
      return opts.force || !rec || rec.mtime !== f.mtime;
    });
    const added = todo.filter((f) => !index.has(f.file_path)).length;

    setScan({ phase: 'matching', total: todo.length, current: 0, removed, message: todo.length ? 'Matching with TMDB…' : 'Up to date' });
    const ctx = new ScanContext();
    let done = 0;
    let failures = 0;
    let networkFailures = 0;
    await pool(todo, CONCURRENCY, async (file) => {
      if (networkFailures >= 6) return; // TMDB unreachable — leave the rest for next scan.
      try {
        await ingestFile(file, ctx, hints.get(file.file_path));
        networkFailures = 0;
      } catch (e) {
        failures++;
        if (e instanceof tmdb.TmdbError && (e.network || e.status === 401)) networkFailures++;
        console.warn('[scan] failed', file.file_path, e);
      } finally {
        done++;
        useLibraryStore.getState().setScan({ current: done, message: file.filename });
        if (done % RELOAD_EVERY === 0) await reload();
      }
    });

    await reload();

    // IMDb ratings: refreshed daily, or right away when new titles arrived. Failures never fail the scan.
    let ratingsNote = '';
    if (networkFailures < 6 && useLibraryStore.getState().settings.imdb_enabled && (added > 0 || imdbSyncDue())) {
      setScan({ phase: 'ratings', message: 'Updating IMDb ratings…' });
      try {
        await syncImdbRatings({ onProgress: (message) => useLibraryStore.getState().setScan({ message }) });
      } catch (e) {
        console.warn('[scan] IMDb sync failed', e);
        ratingsNote = 'IMDb ratings unavailable';
      }
    }

    // The scan card itself turns into the summary, so no separate toast is needed.
    const summary =
      networkFailures >= 6
        ? 'TMDB unreachable — remaining files will be matched next scan'
        : added || removed || failures || organized
          ? [
              `${added} added`,
              `${removed} removed`,
              organized ? `${organized} organized into folders` : '',
              failures ? `${failures} failed` : '',
              ratingsNote,
            ]
              .filter(Boolean)
              .join(' · ')
          : ratingsNote || 'No changes found';
    setScan({ running: false, phase: networkFailures >= 6 ? 'error' : 'done', added, removed, message: summary });
    if (offline.length) toast(`Offline folder skipped: ${offline.join(', ')}`, 'error');
  } catch (e) {
    console.error(e);
    setScan({ running: false, phase: 'error', message: String(e) });
  }
}

/** Standalone IMDb refresh (Settings button, after Fix Match), shown in the scan card. */
export async function runImdbSync(opts: { force?: boolean } = {}) {
  const store = useLibraryStore.getState();
  if (store.scan.running || !store.settings.imdb_enabled) return;
  store.setScan({ running: true, phase: 'ratings', current: 0, total: 0, added: 0, removed: 0, message: 'Updating IMDb ratings…' });
  try {
    await syncImdbRatings({ force: opts.force, onProgress: (message) => useLibraryStore.getState().setScan({ message }) });
    store.setScan({ running: false, phase: 'done', message: 'IMDb ratings updated' });
  } catch (e) {
    store.setScan({ running: false, phase: 'error', message: `IMDb ratings: ${String(e)}` });
  }
}

// ---------------------------------------------------------------------------
// Fix Match
// ---------------------------------------------------------------------------

const techOf = (r: TechInfo): TechInfo => ({
  resolution: r.resolution, video_codec: r.video_codec, hdr_format: r.hdr_format, audio_codec: r.audio_codec,
});
const fileOf = (r: MovieRow | EpisodeRow): FileInfo => ({ file_path: r.file_path, raw_filename: r.raw_filename, file_mtime: r.file_mtime });

async function refreshEpisodes(seriesId: number, tmdbId: number, ctx: ScanContext) {
  for (const ep of await db.getEpisodesForSeries(seriesId)) {
    const meta = await ctx.episodeMeta(tmdbId, ep.season_number, [ep.episode_number]);
    await db.updateEpisodeMetadata(ep.id, meta);
  }
}

/** Overwrites an item's metadata with a user-selected TMDB match (movie <-> TV conversions included). */
export async function applyFixMatch(item: MediaItem, result: SearchResult): Promise<string | null> {
  const { movies, episodesBySeries, reload } = useLibraryStore.getState();
  const ctx = new ScanContext();
  let newKey: string | null = null;

  if (item.kind === 'movie') {
    const rows = movies.filter((m) => m.id === item.id || (item.tmdbId != null && m.tmdb_id === item.tmdbId));
    if (result.kind === 'movie') {
      const meta = await tmdb.getMovieDetails(result.id);
      for (const r of rows) await db.updateMovieMetadata(r.id, meta);
      newKey = item.key;
    } else {
      const series = await ctx.seriesFor(result.title, result.year, null, result.id);
      for (const r of rows) {
        const { season, episode } = guessSeasonEpisode(toRawFile(r.file_path, r.file_mtime));
        const meta = await ctx.episodeMeta(series.tmdbId, season, [episode]);
        await db.deleteMovie(r.id);
        await db.upsertEpisode(series.id, fileOf(r), meta, techOf(r));
      }
      newKey = `tv-${series.id}`;
    }
  } else {
    const eps = episodesBySeries.get(item.id) ?? [];
    if (result.kind === 'tv') {
      const meta = await tmdb.getSeriesDetails(result.id);
      const existing = await db.findSeriesIdByTmdb(result.id);
      let targetId = item.id;
      if (existing != null && existing !== item.id) {
        await db.moveEpisodes(item.id, existing);
        await db.deleteSeries(item.id);
        await db.upsertSeries(meta, null);
        targetId = existing;
      } else {
        await db.updateSeriesById(item.id, meta);
      }
      await refreshEpisodes(targetId, result.id, ctx);
      newKey = `tv-${targetId}`;
    } else {
      const meta = await tmdb.getMovieDetails(result.id);
      for (const ep of eps) await db.upsertMovie(fileOf(ep), meta, techOf(ep));
      await db.deleteSeries(item.id);
    }
  }
  await reload();
  if (!newKey && result.kind === 'movie') {
    newKey = useLibraryStore.getState().items.find((i) => i.kind === 'movie' && i.tmdbId === result.id)?.key ?? null;
  }
  return newKey;
}
