import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EpisodeRow, MediaItem, MovieRow, RawVideoFile, TechInfo } from '../types/media';
import * as db from './db';
import type { EpisodeMetadata, FileInfo, MatchHint, MovieMetadata, SeriesMetadata } from './db';
import { organizeLooseFiles } from './files';
import { startBackgroundAnalysis } from './enrich';
import { reconnectOfflineShares, refreshShares } from './nas';
import { createReloadThrottle } from './libraryReload';
import { runMusicScan } from './music';
import { imdbSyncDue, syncImdbRatings } from './imdb';
import { guessSeasonEpisode, parseVideoFile, toRawFile } from './parser';
import * as tmdb from './tmdb';
import type { SearchResult } from './tmdb';
import { pairMoved } from '../lib/relink';

const CONCURRENCY = 4;
const RELOAD_INTERVAL_MS = 2000;

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
  const info: FileInfo = { file_path: file.file_path, raw_filename: file.filename, file_mtime: file.mtime, file_size: file.file_size };
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

/** Like `isUnder`, but ignores slash direction and letter case (Windows and macOS paths). */
export const isUnderAny = (path: string, root: string) => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const r = norm(root);
  return !!r && (p === r || p.startsWith(`${r}/`));
};

export interface ScanOptions {
  /** Re-fetch metadata for every file, not just new/changed ones. */
  force?: boolean;
  /** Triggered by the folder watcher: no progress card unless something actually changed. */
  quiet?: boolean;
}

let rescanQueued = false;

/** Rust directory walk -> incremental SQLite diff -> parser -> TMDB -> SQLite. */
export async function runScan(opts: ScanOptions = {}) {
  const store = useLibraryStore.getState();
  if (store.scan.running) {
    if (opts.quiet) rescanQueued = true; // a watcher event arrived mid-scan; run again afterwards
    return;
  }
  const { settings, setScan, toast, reload } = store;
  const quiet = !!opts.quiet;
  const dirs = settings.media_directories;

  // Music has its own folders and needs no TMDB key; it scans alongside.
  void runMusicScan({ force: opts.force, quiet });
  if (!dirs.length && settings.music_directories?.length) return;

  if (!settings.tmdb_api_key || !dirs.length) {
    if (!quiet) toast(settings.tmdb_api_key ? 'Add at least one media folder in Settings.' : 'Add your TMDB API key in Settings before scanning.', 'error');
    return;
  }

  setScan({ running: true, quiet, phase: 'walking', current: 0, total: 0, added: 0, removed: 0, message: 'Scanning folders…' });
  try {
    await reconnectOfflineShares(); // NAS folders that dropped off (without waking a sleeping NAS)
    const reachable = await invoke<boolean[]>('check_paths', { paths: dirs });
    const roots = dirs.filter((_, i) => reachable[i]);
    const offline = dirs.filter((_, i) => !reachable[i]);

    const inMusicRoot = (root: string) => (settings.music_directories ?? []).some((m) => isUnderAny(root, m));
    // Tidy loose videos into their own folders first (DB paths are updated, so nothing is re-matched).
    let organized = 0;
    if (settings.organize_loose_files && roots.length) {
      setScan({ message: 'Organizing loose files…' });
      try {
        const res = await organizeLooseFiles(roots.filter((r) => !inMusicRoot(r)));
        organized = res.moved;
        if (res.errors.length) console.warn('[scan] organize issues', res.errors);
      } catch (e) {
        console.warn('[scan] organize failed', e);
      }
    }

    // Music folders belong to Music, even when they sit inside a movie or TV folder.
    const musicDirs = settings.music_directories ?? [];
    const inMusic = (path: string) => musicDirs.some((m) => isUnderAny(path, m));
    const walk = roots.length ? await invoke<{ files: RawVideoFile[]; unreadable: string[] }>('scan_media_folders', { paths: roots }) : { files: [], unreadable: [] };
    const files = walk.files.filter((f) => !inMusic(f.file_path));
    if (walk.unreadable.length) console.warn('[scan] could not read', walk.unreadable.slice(0, 20));

    setScan({ phase: 'diffing', message: `Found ${files.length} videos` });
    const [index, hints, protectedTorrentPaths] = await Promise.all([
      db.getFileIndex(),
      db.getMatchHints(),
      db.getTorrentProtectedPaths(),
    ]);
    const onDisk = new Set(files.map((f) => f.file_path));

    // Prune rows whose files vanished — but never for roots that are merely offline, nor for
    // stream-cached / still-downloading torrent files.
    // Nor for files in a folder that couldn't be read this time (a share dropping out mid-scan).
    const goneMovies: string[] = [];
    const goneEpisodes: string[] = [];
    const missing = [...index].filter(
      ([path]) => !onDisk.has(path) && !protectedTorrentPaths.has(path) && !offline.some((r) => isUnder(path, r)) && !walk.unreadable.some((u) => path === u || isUnder(path, u)),
    );
    // A folder where every one of many titles vanished at once is far more likely an empty mount
    // point or a different disk on the same letter than a real clear-out: leave it, unless this is a
    // full rescan the user asked for.
    const suspicious = opts.force
      ? []
      : roots.filter((r) => {
          const had = [...index.keys()].filter((p) => isUnder(p, r)).length;
          const lost = missing.filter(([p]) => isUnder(p, r)).length;
          return had >= 20 && lost === had;
        });
    if (suspicious.length) console.warn('[scan] not removing titles from', suspicious);
    // Files moved or renamed since the last scan keep their entry (and watch history) at the new path.
    const moved = pairMoved(
      missing.map(([path, rec]) => ({ path, size: rec.size })),
      files.filter((f) => !index.has(f.file_path)).map((f) => ({ path: f.file_path, size: f.file_size })),
    );
    if (moved.length) {
      await db.updateFilePaths(moved);
      for (const { from, to } of moved) {
        const rec = index.get(from)!;
        index.delete(from);
        index.set(to, { ...rec, mtime: files.find((f) => f.file_path === to)?.mtime ?? rec.mtime });
      }
    }
    const relinked = new Set(moved.map((m) => m.from));
    for (const [path, rec] of missing) {
      if (relinked.has(path) || suspicious.some((r) => isUnder(path, r))) continue;
      (rec.type === 'movie' ? goneMovies : goneEpisodes).push(path);
    }
    const removed = goneMovies.length + goneEpisodes.length;
    if (removed) await db.deleteMediaPaths(goneMovies, goneEpisodes);

    // A moved file keeps its match (perhaps chosen with Fix Match) wherever it goes: another drive,
    // a genre folder, "Season 1" renamed "Season 01". Only a renamed show or movie folder ("The
    // Office" → "The Office (US)") matches it again, from there; it stays a movie or an episode.
    const SEASON_DIR = /^(?:season|series|staffel|saison|temporada)[ ._-]*\d{1,2}$|^s\d{1,2}$|^specials?$/i;
    const titleFolder = (p: string) => {
      const parts = p.split(/[\\/]/);
      const parent = parts[parts.length - 2] ?? '';
      return (SEASON_DIR.test(parent) ? parts[parts.length - 3] ?? '' : parent).toLowerCase();
    };
    const rematch = new Map<string, MatchHint>();
    for (const { from, to } of moved) {
      if (titleFolder(from) === titleFolder(to)) continue;
      const was = index.get(to)?.type;
      rematch.set(to, { kind: was === 'episode' ? 'tv' : 'movie' });
    }
    const todo = files.filter((f) => {
      const rec = index.get(f.file_path);
      return opts.force || !rec || rec.mtime !== f.mtime || rematch.has(f.file_path);
    });
    const added = todo.filter((f) => !index.has(f.file_path)).length;

    setScan({ phase: 'matching', total: todo.length, current: 0, removed, message: todo.length ? 'Matching with TMDB…' : 'Up to date' });
    const ctx = new ScanContext();
    let done = 0;
    let failures = 0;
    let networkFailures = 0;
    // Bigger libraries take longer to reload: space reloads out so matching doesn't stutter.
    const reloads = createReloadThrottle(Math.max(RELOAD_INTERVAL_MS, Math.min(15_000, store.items.length * 2)), reload);
    await pool(todo, CONCURRENCY, async (file) => {
      if (networkFailures >= 6) return; // TMDB unreachable — leave the rest for next scan.
      try {
        await ingestFile(file, ctx, rematch.get(file.file_path) ?? hints.get(file.file_path));
        networkFailures = 0;
      } catch (e) {
        failures++;
        if (e instanceof tmdb.TmdbError && (e.network || e.status === 401)) networkFailures++;
        console.warn('[scan] failed', file.file_path, e);
      } finally {
        done++;
        useLibraryStore.getState().setScan({ current: done, message: file.filename });
        reloads.request();
      }
    });

    // Titles appear while matching (throttled), then one final reload — skipped when nothing changed.
    if (todo.length || removed || organized) await reloads.flush();
    else reloads.cancel();

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
    if (offline.length && !quiet) toast(`Offline folder skipped: ${offline.join(', ')}`, 'error');
    void startBackgroundAnalysis();
    void refreshShares();
  } catch (e) {
    console.error(e);
    setScan({ running: false, phase: 'error', message: String(e) });
  }
  if (rescanQueued) {
    rescanQueued = false;
    void runScan({ quiet: true });
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
        await db.upsertEpisode(series.id, fileOf(r), meta, techOf(r));
        // Progress and watched carry over to the episode; a movie on My List puts the show there.
        const epId = await db.mediaIdByPath('episodes', r.file_path);
        if (epId != null) await db.copyProfileState({ type: 'movie', id: r.id }, { type: 'episode', id: epId });
        await db.copyProfileState({ type: 'movie', id: r.id }, { type: 'tv', id: series.id });
        await db.deleteMovie(r.id);
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
        // The show's own My List and last-watched go with its episodes.
        await db.copyProfileState({ type: 'tv', id: item.id }, { type: 'tv', id: existing });
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
      for (const ep of eps) {
        await db.upsertMovie(fileOf(ep), meta, techOf(ep));
        const movieId = await db.mediaIdByPath('movies', ep.file_path);
        if (movieId != null) {
          await db.copyProfileState({ type: 'episode', id: ep.id }, { type: 'movie', id: movieId });
          await db.copyProfileState({ type: 'tv', id: item.id }, { type: 'movie', id: movieId });
        }
      }
      await db.deleteSeries(item.id);
    }
  }
  await reload();
  if (!newKey && result.kind === 'movie') {
    newKey = useLibraryStore.getState().items.find((i) => i.kind === 'movie' && i.tmdbId === result.id)?.key ?? null;
  }
  return newKey;
}
