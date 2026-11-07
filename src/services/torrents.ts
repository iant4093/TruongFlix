import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrent as getDeepLinkCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { useLibraryStore } from '../store/useLibraryStore';
import { episodeTarget, playTargetFor } from '../store/selectors';
import type {
  EpisodeRow,
  FileMove,
  InspectedFile,
  InspectTorrentRes,
  MediaItem,
  MediaKind,
  OsHandlerStatus,
  Settings,
  TorrentEngineConfig,
  TorrentItem,
  TorrentMode,
  TorrentRecord,
  TorrentState,
  TorrentStatus,
} from '../types/media';
import * as db from './db';
import type { EpisodeMetadata, FileInfo, MovieMetadata, SeriesMetadata } from './db';
import { startBackgroundAnalysis } from './enrich';
import { cleanTitle, extractTech, guessSeasonEpisode, parseVideoFile, toRawFile } from './parser';
import { play } from './player';
import * as tmdb from './tmdb';
import { basename } from '../lib/path';
import type { SearchResult } from './tmdb';

const SEASON_PACK_RE = /\bS(\d{1,2})\b(?![ ._-]?E\d)|\bSeason[ ._-]*(\d{1,2})\b|\bComplete[ ._-]*(?:Series|Season|Collection)\b/i;

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function syntheticSeriesId(title: string): number {
  let h = 0;
  for (const ch of normKey(title)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return -((Math.abs(h) % 1_000_000_000) + 1);
}

function sanitizeSubfolder(raw: string): string {
  const cleaned = raw
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  return cleaned || 'Torrent';
}

function joinPath(dir: string, leaf: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + leaf.replace(/^[\\/]+/, '');
}

const isUnder = (filePath: string, root: string) => {
  const r = root.replace(/[\\/]+$/, '');
  return filePath === r || filePath.startsWith(r + '/') || filePath.startsWith(r + '\\');
};

// ---------------------------------------------------------------------------
// Engine configuration sync
// ---------------------------------------------------------------------------

export function buildEngineConfig(s: Settings): TorrentEngineConfig {
  return {
    listen_port: s.torrent_listen_port || 0,
    enable_upnp: s.torrent_upnp,
    enable_dht: s.torrent_dht,
    enable_lsd: s.torrent_lsd,
    disable_trackers: !s.torrent_trackers,
    max_download_kbps: s.torrent_max_download_kbps || 0,
    max_upload_kbps: s.torrent_max_upload_kbps || 0,
    peer_limit: s.torrent_peer_limit || 128,
    stream_cache_dir: null,
  };
}

let lastConfigJson = '';

export async function syncTorrentEngineConfig(settings = useLibraryStore.getState().settings): Promise<number | null> {
  const cfg = buildEngineConfig(settings);
  const serialized = JSON.stringify(cfg);
  if (serialized === lastConfigJson) return null;
  lastConfigJson = serialized;
  try {
    return await invoke<number | null>('torrent_configure', { config: cfg });
  } catch (e) {
    console.warn('[torrents] configure failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inspection, Smart TMDB Matching & Auto Destination Folder Selection
// ---------------------------------------------------------------------------

export async function inspectTorrent(source: string): Promise<InspectTorrentRes> {
  return invoke<InspectTorrentRes>('torrent_inspect', { source });
}

/** Magnet metadata can take well over 10 s to arrive through a VPN. */
export const MAGNET_METADATA_TIMEOUT_MS = 20_000;

export async function inspectTorrentFilesLive(source: string, timeoutMs = MAGNET_METADATA_TIMEOUT_MS): Promise<InspectTorrentRes> {
  return invoke<InspectTorrentRes>('torrent_inspect_files', { source, timeoutMs });
}

export interface TorrentMatchProposal {
  detectedKind: MediaKind;
  parsedTitle: string;
  parsedYear: number | null;
  match: SearchResult | null;
  candidates: SearchResult[];
  recommendedFolder: string;
}

/**
 * Picks the best destination folder from `settings.media_directories` based on whether the torrent
 * matched a Movie or a TV Show (honoring explicit overrides, existing SQLite path distributions,
 * and folder-name patterns).
 */
export function pickDestinationFolder(kind: MediaKind, settings = useLibraryStore.getState().settings): string {
  const dirs = settings.media_directories;
  if (!dirs.length) return '';

  if (kind === 'movie' && settings.torrent_movies_dir && dirs.includes(settings.torrent_movies_dir)) {
    return settings.torrent_movies_dir;
  }
  if (kind === 'tv' && settings.torrent_tv_dir && dirs.includes(settings.torrent_tv_dir)) {
    return settings.torrent_tv_dir;
  }
  if (dirs.length === 1) return dirs[0];

  const { movies, episodes } = useLibraryStore.getState();
  let bestDir = '';
  let bestScore = -1;

  for (const dir of dirs) {
    const movieCount = movies.filter((m) => isUnder(m.file_path, dir)).length;
    const epCount = episodes.filter((e) => isUnder(e.file_path, dir)).length;
    const base = basename(dir);

    let score = 0;
    if (kind === 'movie') {
      if (/\b(?:movies?|films?|cinema|uhd\s*movies?)\b/i.test(base)) score += 50;
      if (/\b(?:tv|shows?|series|anime)\b/i.test(base)) score -= 40;
      if (movieCount > 0 && epCount === 0) score += 35;
      else if (movieCount > epCount) score += 15;
    } else {
      if (/\b(?:tv|shows?|series|anime|television)\b/i.test(base)) score += 50;
      if (/\b(?:movies?|films?|cinema)\b/i.test(base)) score -= 40;
      if (epCount > 0 && movieCount === 0) score += 35;
      else if (epCount > movieCount) score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestDir = dir;
    }
  }

  return bestScore > 0 && bestDir ? bestDir : dirs[0];
}

export function parseTorrentIdentity(name: string, files: InspectedFile[]): { kind: MediaKind; title: string; year: number | null } {
  const videoFiles = files.filter((f) => f.is_video);

  // Multiple episode-like videos or season pack naming -> TV Show
  const tvVideoFiles = videoFiles.filter((f) => {
    const p = parseVideoFile(toRawFile(joinPath(name, f.relative_path), 0));
    return p.kind === 'tv';
  });

  if (tvVideoFiles.length > 0 || SEASON_PACK_RE.test(name) || videoFiles.length >= 3) {
    if (tvVideoFiles.length > 0) {
      const sample = parseVideoFile(toRawFile(joinPath(name, tvVideoFiles[0].relative_path), 0));
      if (sample.kind === 'tv' && sample.showTitle) {
        return { kind: 'tv', title: sample.showTitle, year: sample.year };
      }
    }
    const stripped = name.split(/[ ._-](?:S\d{1,2}\b|Season[ ._-]*\d{1,2}\b|Complete\b)/i)[0] || name;
    const parsedOuter = parseVideoFile(toRawFile(`${stripped}.mkv`, 0));
    const title = parsedOuter.kind === 'movie' ? parsedOuter.title : parsedOuter.showTitle;
    return { kind: 'tv', title: title || cleanTitle(name) || name, year: parsedOuter.year };
  }

  const primaryName = videoFiles.length === 1 ? videoFiles[0].name : `${name}.mkv`;
  const parsed = parseVideoFile(toRawFile(joinPath(name, primaryName), 0));
  if (parsed.kind === 'tv') {
    return { kind: 'tv', title: parsed.showTitle || cleanTitle(name) || name, year: parsed.year };
  }
  return {
    kind: 'movie',
    title: parsed.title || cleanTitle(name) || name,
    year: parsed.year,
  };
}

export async function matchTorrentMetadata(name: string, files: InspectedFile[]): Promise<TorrentMatchProposal> {
  const identity = parseTorrentIdentity(name, files);
  const { settings } = useLibraryStore.getState();
  let detectedKind: MediaKind = identity.kind;
  let candidates: SearchResult[] = [];

  if (settings.tmdb_api_key && identity.title.trim()) {
    try {
      candidates = await tmdb.searchTitles(detectedKind, identity.title, identity.year);
      if (!candidates.length && identity.year != null) {
        candidates = await tmdb.searchTitles(detectedKind, identity.title, null);
      }
      if (!candidates.length) {
        const altKind: MediaKind = detectedKind === 'movie' ? 'tv' : 'movie';
        const alt = await tmdb.searchTitles(altKind, identity.title, identity.year);
        if (alt.length) {
          detectedKind = altKind;
          candidates = alt;
        }
      }
    } catch (e) {
      console.warn('[torrents] TMDB auto-match failed', e);
    }
  }

  const match = candidates[0] ?? null;
  const finalKind = match?.kind ?? detectedKind;
  return {
    detectedKind: finalKind,
    parsedTitle: identity.title,
    parsedYear: identity.year,
    match,
    candidates,
    recommendedFolder: pickDestinationFolder(finalKind, settings),
  };
}

// ---------------------------------------------------------------------------
// Immediate Library Ingestion & Magnet Resolution Reconciler
// ---------------------------------------------------------------------------

function unmatchedMovieMeta(title: string, year: number | null): MovieMetadata {
  return {
    tmdb_id: null,
    title,
    original_title: null,
    year,
    overview: null,
    tagline: null,
    runtime: null,
    vote_average: null,
    genres: [],
    cast_crew: [],
    poster_path: null,
    backdrop_path: null,
    logo_path: null,
    imdb_id: null,
  };
}

function unmatchedSeriesMeta(title: string, year: number | null): SeriesMetadata {
  return {
    tmdb_id: syntheticSeriesId(title),
    title,
    year,
    overview: null,
    vote_average: null,
    genres: [],
    cast_crew: [],
    poster_path: null,
    backdrop_path: null,
    logo_path: null,
    number_of_seasons: 1,
    imdb_id: null,
  };
}

async function ingestTorrentFilesIntoLibrary(opts: {
  name: string;
  outputFolder: string;
  videoFiles: { full_path: string; name: string; relative_path: string; size: number }[];
  kind: MediaKind;
  tmdbId: number | null;
  fallbackTitle: string;
  fallbackYear: number | null;
}): Promise<{ filePaths: string[]; movieId: number | null; seriesId: number | null; resolvedTmdbId: number | null }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const { settings } = useLibraryStore.getState();
  const canQueryTmdb = !!settings.tmdb_api_key;

  // Placeholder file if magnet metadata is still resolving from peers
  const effectiveVideos =
    opts.videoFiles.length > 0
      ? opts.videoFiles
      : [
          {
            full_path: joinPath(opts.outputFolder, `${sanitizeSubfolder(opts.name)}.mkv`),
            name: `${sanitizeSubfolder(opts.name)}.mkv`,
            relative_path: `${sanitizeSubfolder(opts.name)}.mkv`,
            size: 0,
          },
        ];

  const filePaths = effectiveVideos.map((f) => f.full_path);

  if (opts.kind === 'movie') {
    const primary = effectiveVideos.reduce((best, cur) => (cur.size >= best.size ? cur : best), effectiveVideos[0]);
    let meta: MovieMetadata = unmatchedMovieMeta(opts.fallbackTitle, opts.fallbackYear);
    if (opts.tmdbId && canQueryTmdb) {
      try {
        meta = await tmdb.getMovieDetails(opts.tmdbId);
      } catch (e) {
        console.warn('[torrents] movie details fallback', e);
      }
    }
    const tech = extractTech(primary.name || opts.name);
    const info: FileInfo = {
      file_path: primary.full_path,
      raw_filename: primary.name,
      file_mtime: nowSec,
      file_size: primary.size || null,
    };
    await db.upsertMovie(info, meta, tech);
    const movieId = await db.findMovieIdByPath(primary.full_path);
    return { filePaths: [primary.full_path], movieId, seriesId: null, resolvedTmdbId: meta.tmdb_id };
  }

  // TV Show (single episode or full season/series pack)
  let seriesMeta: SeriesMetadata = unmatchedSeriesMeta(opts.fallbackTitle, opts.fallbackYear);
  if (opts.tmdbId && opts.tmdbId > 0 && canQueryTmdb) {
    try {
      seriesMeta = await tmdb.getSeriesDetails(opts.tmdbId);
    } catch (e) {
      console.warn('[torrents] series details fallback', e);
    }
  }
  const seriesId = await db.upsertSeries(seriesMeta, opts.outputFolder);
  const seasonCache = new Map<number, Map<number, EpisodeMetadata>>();

  for (let i = 0; i < effectiveVideos.length; i++) {
    const vf = effectiveVideos[i];
    const raw = toRawFile(vf.full_path, nowSec);
    const parsed = parseVideoFile(raw);
    const guessed = guessSeasonEpisode(raw);
    const season = parsed.kind === 'tv' ? parsed.season : guessed.season;
    const epNums = parsed.kind === 'tv' ? parsed.episodes : [guessed.episode || i + 1];

    let epMap = seasonCache.get(season);
    if (!epMap) {
      epMap =
        seriesMeta.tmdb_id > 0 && canQueryTmdb
          ? await tmdb.getSeasonEpisodes(seriesMeta.tmdb_id, season).catch(() => new Map())
          : new Map();
      seasonCache.set(season, epMap);
    }

    const found = epNums.map((n) => epMap!.get(n)).filter((x): x is EpisodeMetadata => !!x);
    const epMeta: EpisodeMetadata =
      found.length === 1
        ? found[0]
        : found.length > 1
          ? {
              ...found[0],
              title: found.map((x) => x.title).join(' / '),
              runtime: found.reduce((s, x) => s + (x.runtime ?? 0), 0) || found[0].runtime,
            }
          : {
              tmdb_episode_id: null,
              season_number: season,
              episode_number: epNums[0] ?? i + 1,
              title: epNums.length > 1 ? `Episodes ${epNums.join('–')}` : `Episode ${epNums[0] ?? i + 1}`,
              overview: null,
              still_path: null,
              air_date: null,
              runtime: null,
            };

    await db.upsertEpisode(
      seriesId,
      {
        file_path: vf.full_path,
        raw_filename: vf.name,
        file_mtime: nowSec,
        file_size: vf.size || null,
      },
      epMeta,
      extractTech(vf.name),
    );
  }

  return { filePaths, movieId: null, seriesId, resolvedTmdbId: seriesMeta.tmdb_id };
}

export interface InitiateTorrentOptions {
  source: string;
  name: string;
  mode: TorrentMode;
  destinationRoot: string;
  deleteOnComplete: boolean;
  cacheHours: number;
  onlyFiles?: number[];
  match: SearchResult | null;
  fallbackKind: MediaKind;
  fallbackTitle: string;
  fallbackYear: number | null;
  playImmediately?: boolean;
  abortSignal?: AbortSignal;
}

const autoPlayQueue = new Set<string>();

export async function initiateTorrent(opts: InitiateTorrentOptions): Promise<TorrentStatus> {
  await syncTorrentEngineConfig();
  if (opts.abortSignal?.aborted) throw new DOMException('Canceled', 'AbortError');

  const kind: MediaKind = opts.match?.kind ?? opts.fallbackKind;
  const cleanTitleStr = opts.match?.title ?? (opts.fallbackTitle || cleanTitle(opts.name) || opts.name);
  const year = opts.match?.year ?? opts.fallbackYear;
  const subFolder =
    kind === 'movie'
      ? sanitizeSubfolder(year ? `${cleanTitleStr} (${year})` : cleanTitleStr)
      : sanitizeSubfolder(year ? `${cleanTitleStr} (${year})` : cleanTitleStr);

  const status = await invoke<TorrentStatus>('torrent_add', {
    req: {
      source: opts.source,
      is_stream: opts.mode === 'stream',
      output_folder: opts.mode === 'download' ? opts.destinationRoot : null,
      sub_folder: opts.mode === 'download' ? subFolder : null,
      only_files: opts.onlyFiles ?? null,
      paused: false,
      initial_peers: null,
    },
  });

  const includedVideos = status.files.filter((f) => f.included && f.is_video);
  const ingested = await ingestTorrentFilesIntoLibrary({
    name: status.name || opts.name,
    outputFolder: status.output_folder,
    videoFiles: includedVideos,
    kind,
    tmdbId: opts.match?.id ?? null,
    fallbackTitle: cleanTitleStr,
    fallbackYear: year,
  });

  const hours = opts.mode === 'stream' ? Math.max(1, opts.cacheHours || 72) : null;
  const expiresAt = hours != null ? new Date(Date.now() + hours * 3600_000).toISOString() : null;

  await db.upsertTorrentRecord({
    info_hash: status.info_hash,
    name: status.name || opts.name,
    source: opts.source,
    mode: opts.mode,
    save_path: status.output_folder,
    delete_on_complete: opts.deleteOnComplete,
    cache_hours: hours,
    expires_at: expiresAt,
    media_kind: kind,
    tmdb_id: ingested.resolvedTmdbId,
    series_id: ingested.seriesId,
    movie_id: ingested.movieId,
    file_paths: ingested.filePaths,
    total_bytes: status.total_bytes,
    completed_at: status.finished ? new Date().toISOString() : null,
    seeding_stopped: false,
  });

  await pollTorrents();
  await useLibraryStore.getState().reload();
  scheduleAdaptivePoll();

  const store = useLibraryStore.getState();
  if (opts.playImmediately && opts.mode === 'stream' && !opts.abortSignal?.aborted) {
    if (status.files.length > 0) {
      await playTorrentByHash(status.info_hash);
    } else {
      autoPlayQueue.add(status.info_hash.toLowerCase());
      store.toast(`Connecting to peers for “${cleanTitleStr}” — playback will start automatically…`, 'info');
    }
  } else {
    store.toast(
      opts.mode === 'stream'
        ? `Added stream “${cleanTitleStr}” (cached for ${formatHoursLabel(hours ?? 72)})`
        : `Downloading “${cleanTitleStr}” to ${opts.destinationRoot}`,
      'success',
    );
  }

  return status;
}

// ---------------------------------------------------------------------------
// Actions, Keep in Library Promotion, & Stream URL Resolution
// ---------------------------------------------------------------------------

export async function pauseTorrent(infoHash: string) {
  await invoke('torrent_action', { infoHash, action: 'pause' });
  await pollTorrents();
}

export async function resumeTorrent(infoHash: string) {
  await invoke('torrent_action', { infoHash, action: 'resume' });
  await pollTorrents();
  scheduleAdaptivePoll();
}

export async function stopSeedingTorrent(infoHash: string) {
  const item = useLibraryStore.getState().torrents.find((t) => t.infoHash === infoHash.toLowerCase());
  await stopSeedingHandle(infoHash, item?.filePaths ?? []);
  await db.updateTorrentRecord(infoHash, { seeding_stopped: true });
  await pollTorrents();
  useLibraryStore.getState().toast('Stopped seeding (downloaded files kept in library)', 'info');
}

/** Completed HTTP streams still need their torrent handle for subsequent byte-range requests. */
function isPlayingTorrent(paths: string[]): boolean {
  const store = useLibraryStore.getState();
  const targets = [store.playerSession?.target, store.cast?.target];
  if (targets.some((t) => t && t.type !== 'live' && paths.includes(t.filePath))) return true;
  if (!store.playback.active) return false;
  const row = store.playback.type === 'movie'
    ? store.movies.find((m) => m.id === store.playback.id)
    : store.episodes.find((e) => e.id === store.playback.id);
  return !!row && paths.includes(row.file_path);
}

async function stopSeedingHandle(infoHash: string, paths: string[]) {
  // Pausing keeps storage and range requests alive, while stopping uploads immediately.
  await invoke('torrent_action', { infoHash, action: isPlayingTorrent(paths) ? 'pause' : 'delete_keep_files' });
}

export async function setTorrentDeleteOnComplete(infoHash: string, value: boolean) {
  await db.updateTorrentRecord(infoHash, { delete_on_complete: value });
  const item = useLibraryStore.getState().torrents.find((t) => t.infoHash === infoHash.toLowerCase());
  if (value && item?.finished && item.inSession) {
    await stopSeedingTorrent(infoHash);
    return;
  }
  await pollTorrents();
}

const transferStatusLabels: Record<TorrentState, string> = {
  resolving: 'Fetching metadata',
  initializing: 'Checking files',
  downloading: 'Downloading',
  seeding: 'Seeding',
  paused: 'Paused',
  completed: 'Completed',
  stopped_seeding: 'Complete · Not seeding',
  error: 'Error',
};

export function torrentStatusLabel(t: TorrentItem): string {
  return transferStatusLabels[t.error ? 'error' : t.state];
}

export function isActiveDownload(t: TorrentItem): boolean {
  return t.inSession && !t.finished && !t.paused && !t.error
    && (t.state === 'resolving' || t.state === 'initializing' || t.state === 'downloading');
}

const removalsInProgress = new Set<string>();
const failedFileRemovals = new Set<string>();

export async function removeTorrent(infoHash: string, deleteFilesAndLibraryRows: boolean) {
  const hash = infoHash.toLowerCase();
  if (removalsInProgress.has(hash)) throw new Error('This torrent is already being removed.');
  removalsInProgress.add(hash);

  try {
    // Let any existing reconciliation finish before modifying the same library paths.
    await pollInFlight?.catch(() => {});
    const records = await db.listTorrentRecords();
    const rec = records.find((r) => r.info_hash.toLowerCase() === hash);
    const paths: string[] = rec && deleteFilesAndLibraryRows ? JSON.parse(rec.file_paths) : [];
    if (deleteFilesAndLibraryRows && isPlayingTorrent(paths)) {
      throw new Error('Stop playback before deleting this torrent’s files.');
    }

    await invoke('torrent_action', {
      infoHash: hash,
      action: deleteFilesAndLibraryRows ? 'delete_with_files' : 'remove_transfer',
      ...(deleteFilesAndLibraryRows && rec?.mode === 'stream' ? { streamCachePath: rec.save_path } : {}),
    });

    if (paths.length) await db.deleteMediaPaths(paths, paths);
    await db.deleteTorrentRecord(hash);
    await pollInFlight?.catch(() => {});
    failedFileRemovals.delete(hash);
    autoPlayQueue.delete(hash);
    const store = useLibraryStore.getState();
    store.setTorrents(store.torrents.filter((t) => t.infoHash !== hash));
  } catch (e) {
    if (deleteFilesAndLibraryRows) failedFileRemovals.add(hash);
    throw e;
  } finally {
    removalsInProgress.delete(hash);
  }

  await Promise.allSettled([pollTorrents(), useLibraryStore.getState().reload()]);
}

export async function pauseAllTorrents() {
  const active = useLibraryStore.getState().torrents.filter((t) => t.inSession && !t.paused);
  await Promise.all(active.map((t) => invoke('torrent_action', { infoHash: t.infoHash, action: 'pause' }).catch(() => {})));
  await pollTorrents();
}

export async function resumeAllTorrents() {
  const paused = useLibraryStore.getState().torrents.filter((t) => t.inSession && t.paused);
  await Promise.all(paused.map((t) => invoke('torrent_action', { infoHash: t.infoHash, action: 'resume' }).catch(() => {})));
  await pollTorrents();
  scheduleAdaptivePoll();
}

/**
 * Promotes a temporary `Stream` item into a permanent `Download` in the user's library folder,
 * clearing its expiry countdown and moving completed files out of `stream-cache`.
 */
export async function keepStreamPermanently(infoHash: string, explicitRoot?: string) {
  const hash = infoHash.toLowerCase();
  const store = useLibraryStore.getState();
  const item = store.torrents.find((t) => t.infoHash === hash);
  if (!item) return;

  const destRoot = explicitRoot || pickDestinationFolder(item.mediaKind ?? 'movie', store.settings);
  if (!destRoot) {
    store.toast('Add a media library folder in Settings first to keep files permanently.', 'error');
    return;
  }

  const libItem =
    (item.movieId != null ? store.items.find((i) => i.kind === 'movie' && i.id === item.movieId) : null) ??
    (item.seriesId != null ? store.items.find((i) => i.kind === 'tv' && i.id === item.seriesId) : null);
  const subName = sanitizeSubfolder(
    libItem ? (libItem.year ? `${libItem.title} (${libItem.year})` : libItem.title) : cleanTitle(item.name) || item.name,
  );
  const targetDir = joinPath(destRoot, subName);

  if (item.finished && !isPlayingTorrent(item.filePaths)) {
    // Release open file handles in session first, then move completed files to permanent library folder.
    if (item.inSession) {
      await invoke('torrent_action', { infoHash: hash, action: 'delete_keep_files' }).catch(() => {});
    }
    const moves: FileMove[] = item.filePaths.map((from) => {
      const leaf = basename(from) || 'video.mkv';
      return { from, to: joinPath(targetDir, leaf) };
    });
    if (moves.length) {
      await invoke('apply_moves', { moves });
      await db.updateFilePaths(moves);
    }
    await db.updateTorrentRecord(hash, {
      mode: 'download',
      cache_hours: null,
      expires_at: null,
      save_path: targetDir,
      file_paths: moves.map((m) => m.to),
      seeding_stopped: true,
    });
  } else {
    // Remove expiry immediately; polling moves the files once complete and no longer playing.
    await db.updateTorrentRecord(hash, {
      mode: 'download',
      cache_hours: null,
      expires_at: null,
      save_path: targetDir,
    });
  }

  await pollTorrents();
  await store.reload();
  store.toast(`Saved “${libItem?.title ?? item.name}” permanently to your library`, 'success');
}

export async function playTorrentByHash(infoHash: string) {
  const hash = infoHash.toLowerCase();
  const store = useLibraryStore.getState();
  const t = store.torrents.find((x) => x.infoHash === hash);
  if (!t) return;
  if (!t.finished && !canStreamTorrent(t)) {
    const libItem =
      (t.movieId != null ? store.items.find((i) => i.kind === 'movie' && i.id === t.movieId) : null) ??
      (t.seriesId != null ? store.items.find((i) => i.kind === 'tv' && i.id === t.seriesId) : null);
    store.toast(stillDownloadingMessage(libItem?.title ?? t.name), 'info');
    return;
  }

  if (t.movieId != null) {
    const item = store.items.find((i) => i.kind === 'movie' && i.id === t.movieId);
    if (item) {
      const target = playTargetFor(item, store.episodesBySeries);
      if (target) return play(target);
    }
  }
  if (t.seriesId != null) {
    const item = store.items.find((i) => i.kind === 'tv' && i.id === t.seriesId);
    const included = store.episodes.filter((e) => e.series_id === t.seriesId && t.filePaths.includes(e.file_path));
    if (item) {
      const target = playTargetFor(item, new Map([[t.seriesId, included]]));
      if (target) return play(target);
    }
    const ep = included[0];
    if (ep) return play(episodeTarget(ep, { title: t.name }));
  }

  // Fallback: stream directly by infoHash
  try {
    const url = await invoke<string>('torrent_stream_url', { infoHash: hash, fileIndex: null });
    return play({
      type: 'movie',
      id: t.movieId ?? -1,
      filePath: url,
      startTime: 0,
      label: t.name,
    });
  } catch (e) {
    store.toast(String(e), 'error');
  }
}

/**
 * If `filePath` belongs to an active torrent that hasn't finished downloading yet, returns a local
 * HTTP byte-range stream URL (`http://127.0.0.1:<port>/torrent/...`) so `libmpv` or VLC streams
 * pieces sequentially on demand!
 */
export async function resolvePlayablePathOrStream(filePath: string): Promise<string> {
  if (filePath.startsWith('http://127.0.0.1:')) return filePath;
  const store = useLibraryStore.getState();
  const match = torrentForFile(filePath, store.torrents);
  if (!match) return filePath;
  if (match.finished && !match.inSession) return filePath;
  if (!match.finished && !canStreamTorrent(match)) {
    if (!downloadBlockingPlayback(filePath, [match])) return filePath;
    const message = stillDownloadingMessage(match.name);
    store.toast(message, 'info');
    throw new Error(message);
  }
  if (match.finished) {
    // Check if the completed file is directly reachable on disk; if so, direct file playback is fastest.
    const ok = await invoke<boolean[]>('check_paths', { paths: [filePath] }).catch(() => [false]);
    if (ok[0]) return filePath;
  }
  const fileObj = match.files.find((f) => f.full_path === filePath);
  return invoke<string>('torrent_stream_url', {
    infoHash: match.infoHash,
    fileIndex: fileObj ? fileObj.index : null,
  });
}

export async function checkOsHandlerStatus(): Promise<OsHandlerStatus> {
  return invoke<OsHandlerStatus>('torrent_check_os_handler');
}

export async function registerOsHandler(): Promise<OsHandlerStatus> {
  return invoke<OsHandlerStatus>('torrent_register_os_handler');
}

// ---------------------------------------------------------------------------
// Selectors & Formatting Helpers for Library Posters and Detail Screens
// ---------------------------------------------------------------------------

interface TorrentIndex {
  size: number;
  movieId: Map<number, number>;
  filePath: Map<string, number>;
  movieTmdb: Map<number, number>;
  seriesId: Map<number, number>;
  tvTmdb: Map<number, number>;
}

const torrentIndexes = new WeakMap<TorrentItem[], TorrentIndex>();

/** O(1)-lookup index over a torrents array (built once per array identity). */
function torrentIndex(torrents: TorrentItem[]): TorrentIndex {
  let idx = torrentIndexes.get(torrents);
  if (idx && idx.size === torrents.length) return idx;
  idx = { size: torrents.length, movieId: new Map(), filePath: new Map(), movieTmdb: new Map(), seriesId: new Map(), tvTmdb: new Map() };
  const put = <K,>(m: Map<K, number>, k: K, i: number) => {
    if (!m.has(k)) m.set(k, i);
  };
  torrents.forEach((t, i) => {
    if (t.movieId != null) put(idx!.movieId, t.movieId, i);
    for (const p of t.filePaths) put(idx!.filePath, p, i);
    if (t.tmdbId != null && t.mediaKind === 'movie') put(idx!.movieTmdb, t.tmdbId, i);
    if (t.seriesId != null) put(idx!.seriesId, t.seriesId, i);
    if (t.tmdbId != null && t.mediaKind === 'tv') put(idx!.tvTmdb, t.tmdbId, i);
  });
  torrentIndexes.set(torrents, idx);
  return idx;
}

/**
 * The first torrent (in list order) attached to an item by movie/series id, file path or TMDB id.
 * Uses a per-array index, so every card can look itself up in O(1) after each poll.
 */
export function torrentForItem(item: MediaItem, torrents: TorrentItem[]): TorrentItem | null {
  if (!torrents.length) return null;
  const idx = torrentIndex(torrents);
  let best = Infinity;
  const consider = (i: number | undefined) => {
    if (i != null && i < best) best = i;
  };
  if (item.kind === 'movie') {
    consider(idx.movieId.get(item.id));
    for (const v of item.versions) consider(idx.movieId.get(v.id));
    if (item.filePath) consider(idx.filePath.get(item.filePath));
    if (item.tmdbId != null) consider(idx.movieTmdb.get(item.tmdbId));
  } else {
    consider(idx.seriesId.get(item.id));
    if (item.tmdbId != null) consider(idx.tvTmdb.get(item.tmdbId));
  }
  return best === Infinity ? null : torrents[best];
}

export function torrentForEpisode(ep: EpisodeRow, torrents: TorrentItem[]): TorrentItem | null {
  if (!torrents.length) return null;
  return (
    torrents.find((t) => t.filePaths.includes(ep.file_path) || t.files.some((f) => f.full_path === ep.file_path)) ??
    torrents.find((t) => t.seriesId === ep.series_id && t.state === 'resolving') ??
    null
  );
}

/**
 * Only transfers the user chose to stream may play before they finish. A stream promoted with
 * "Keep" switches to download mode but stays streamable while its files are still in the stream cache.
 */
export function canStreamTorrent(t: TorrentItem): boolean {
  if (t.finished) return false;
  if (t.mode === 'stream') return true;
  if (!t.savePath) return false;
  return [...t.files.map((f) => f.full_path), ...t.filePaths].some((p) => !isUnder(p, t.savePath));
}

export function torrentForFile(filePath: string, torrents: TorrentItem[]): TorrentItem | null {
  return torrents.find((t) => t.filePaths.includes(filePath) || t.files.some((f) => f.full_path === filePath)) ?? null;
}

/** The unfinished, non-streamable download still writing `filePath`, if any (a file it already completed may play). */
export function downloadBlockingPlayback(filePath: string, torrents: TorrentItem[]): TorrentItem | null {
  const t = torrentForFile(filePath, torrents);
  if (!t || t.finished || canStreamTorrent(t)) return null;
  const f = t.files.find((x) => x.full_path === filePath);
  if (f && f.size > 0 && f.downloaded_bytes >= f.size) return null;
  return t;
}

export function stillDownloadingMessage(title: string): string {
  return `“${title}” is still downloading — it will be playable when the download finishes.`;
}

export function formatDownloadingLabel(pct: number): string {
  return `Downloading ${pct.toFixed(0)}%`;
}

export function episodeFileProgress(ep: EpisodeRow, torrent: TorrentItem | null): { downloading: boolean; pct: number } | null {
  if (!torrent || torrent.finished) return null;
  const f = torrent.files.find((x) => x.full_path === ep.file_path);
  if (!f) return { downloading: true, pct: torrent.progressPct };
  if (f.size > 0 && f.downloaded_bytes >= f.size) return null;
  const pct = f.size > 0 ? Math.min(100, (f.downloaded_bytes / f.size) * 100) : torrent.progressPct;
  return { downloading: true, pct };
}

export function formatEta(secs: number | null): string {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return '—';
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const mins = Math.floor(secs / 60);
  const remS = Math.floor(secs % 60);
  if (mins < 60) return `${mins}m ${remS}s`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 48) return `${hrs}h ${remM}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export function formatHoursLabel(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const days = hours / 24;
  return Number.isInteger(days) ? `${days}d` : `${hours}h`;
}

export function formatExpiryRemaining(expiresAt: string | null, compact = true): { label: string; urgent: boolean; expired: boolean } | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return { label: compact ? 'Clearing…' : 'Cache expired · clearing soon', urgent: true, expired: true };

  const totalMins = Math.ceil(ms / 60_000);
  const totalHours = Math.floor(totalMins / 60);
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  const remMins = totalMins % 60;
  const urgent = totalHours < 6;

  if (compact) {
    if (days >= 1) return { label: `${days}d ${remHours}h`, urgent, expired: false };
    if (totalHours >= 1) return { label: `${totalHours}h ${remMins}m`, urgent, expired: false };
    return { label: `${totalMins}m left`, urgent: true, expired: false };
  }

  if (days >= 1) {
    return {
      label: `Clears in ${days} day${days === 1 ? '' : 's'}${remHours ? `, ${remHours} hr` : ''}`,
      urgent,
      expired: false,
    };
  }
  if (totalHours >= 1) {
    return {
      label: `Clears in ${totalHours} hr${remMins ? ` ${remMins} min` : ''}`,
      urgent,
      expired: false,
    };
  }
  return { label: `Clears in ${totalMins} min`, urgent: true, expired: false };
}

// ---------------------------------------------------------------------------
// Polling, Magnet Reconciler, Seeding Policy & Stream Cache Reaper
// ---------------------------------------------------------------------------

let pollInFlight: Promise<TorrentItem[]> | null = null;
let pollTimer: number | null = null;
const unlisteners: UnlistenFn[] = [];

// Parsed `file_paths` JSON, keyed by the raw string so unchanged records skip re-parsing every poll.
let parsedPathsCache = new Map<string, string[]>();

function parseFilePaths(raw: string): string[] {
  const hit = parsedPathsCache.get(raw);
  if (hit) return hit;
  let paths: string[] = [];
  try {
    paths = JSON.parse(raw) as string[];
  } catch {
    paths = [];
  }
  parsedPathsCache.set(raw, paths);
  return paths;
}

const sameStrings = (a: string[], b: string[]) => a === b || (a.length === b.length && a.every((v, i) => v === b[i]));

function sameFiles(a: TorrentItem['files'], b: TorrentItem['files']): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as unknown as Record<string, unknown>;
    const y = b[i] as unknown as Record<string, unknown>;
    if (x === y) continue;
    for (const k in x) if (x[k] !== y[k]) return false;
    for (const k in y) if (!(k in x)) return false;
  }
  return true;
}

/** Field-wise equality for poll results; arrays are compared by content. */
function sameTorrent(a: TorrentItem, b: TorrentItem): boolean {
  for (const k in a) {
    const key = k as keyof TorrentItem;
    if (key === 'filePaths') {
      if (!sameStrings(a.filePaths, b.filePaths)) return false;
    } else if (key === 'files') {
      if (!sameFiles(a.files, b.files)) return false;
    } else if (a[key] !== b[key]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

/** Reuses unchanged records' identities; returns `prev` itself when nothing changed. */
export function reconcileTorrentList(prev: TorrentItem[], next: TorrentItem[]): TorrentItem[] {
  const byHash = new Map(prev.map((t) => [t.infoHash, t]));
  let changed = prev.length !== next.length;
  const out = next.map((t, i) => {
    const old = byHash.get(t.infoHash);
    const kept = old && (old === t || sameTorrent(old, t)) ? old : t;
    if (kept !== prev[i]) changed = true;
    return kept;
  });
  return changed ? out : prev;
}

async function reconcileMagnetFilesIfNeeded(rec: TorrentRecord, live: TorrentStatus, storedPaths: string[]): Promise<string[]> {
  let liveVideoFiles = live.files.filter((f) => f.included && f.is_video);
  if (!liveVideoFiles.length) return storedPaths;
  // Movie torrents may contain extras. Ingestion represents the largest video as the movie;
  // comparing that single stored path to every extra used to delete/recreate it on every poll.
  if (rec.media_kind !== 'tv') liveVideoFiles = [liveVideoFiles.reduce((best, f) => f.size >= best.size ? f : best)];

  const livePaths = liveVideoFiles.map((f) => f.full_path);
  const same =
    storedPaths.length === livePaths.length && storedPaths.every((p) => livePaths.includes(p));
  if (same) return storedPaths;

  // Replace placeholder rows from magnet resolution with actual video files!
  const obsoletePaths = storedPaths.filter((p) => !livePaths.includes(p));
  if (obsoletePaths.length) {
    await db.deleteMediaPaths(obsoletePaths, obsoletePaths);
  }
  const kind: MediaKind = rec.media_kind ?? 'movie';
  const ingested = await ingestTorrentFilesIntoLibrary({
    name: live.name || rec.name,
    outputFolder: live.output_folder,
    videoFiles: liveVideoFiles,
    kind,
    tmdbId: rec.tmdb_id,
    fallbackTitle: cleanTitle(live.name || rec.name) || rec.name,
    fallbackYear: null,
  });

  await db.updateTorrentRecord(rec.info_hash, {
    name: live.name || rec.name,
    file_paths: ingested.filePaths,
    total_bytes: live.total_bytes,
    movie_id: ingested.movieId,
    series_id: ingested.seriesId,
  });
  rec.name = live.name || rec.name;
  rec.movie_id = ingested.movieId;
  rec.series_id = ingested.seriesId;
  await useLibraryStore.getState().reload();
  return ingested.filePaths;
}

const completionListeners = new Set<(torrent: TorrentItem) => void>();

/** Called once when a torrent finishes downloading. Returns an unsubscribe function. */
export function onTorrentCompleted(listener: (torrent: TorrentItem) => void): () => void {
  completionListeners.add(listener);
  return () => completionListeners.delete(listener);
}

export function pollTorrents(): Promise<TorrentItem[]> {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    const [records, liveList] = await Promise.all([
      db.listTorrentRecords(),
      invoke<TorrentStatus[]>('torrent_list').catch(() => [] as TorrentStatus[]),
    ]);

    const liveMap = new Map<string, TorrentStatus>();
    for (const l of liveList) liveMap.set(l.info_hash.toLowerCase(), l);

    const { settings } = useLibraryStore.getState();
    let merged: TorrentItem[] = [];
    let needsLibraryReload = false;
    let triggerProbe = false;
    const justCompleted: string[] = [];
    const prevCache = parsedPathsCache;
    parsedPathsCache = new Map();
    const parse = (raw: string) => {
      const hit = prevCache.get(raw);
      if (hit) parsedPathsCache.set(raw, hit);
      return hit ?? parseFilePaths(raw);
    };

    for (const rec of records) {
      const hash = rec.info_hash.toLowerCase();
      if (removalsInProgress.has(hash)) {
        const previous = useLibraryStore.getState().torrents.find((t) => t.infoHash === hash);
        if (previous) merged.push(previous);
        continue;
      }
      const live = liveMap.get(hash);
      let filePaths: string[] = parse(rec.file_paths);

      const isGame = rec.purpose === 'game';
      if (live && live.files.length > 0 && !isGame) {
        filePaths = await reconcileMagnetFilesIfNeeded(rec, live, filePaths);
      }

      let completedAt = rec.completed_at;
      let seedingStopped = rec.seeding_stopped === 1;
      let savePath = rec.save_path;
      let expiresAt = rec.expires_at;

      // Transition from downloading -> finished!
      if (live?.finished && !completedAt) {
        completedAt = new Date().toISOString();
        if (rec.mode === 'stream' && rec.cache_hours) {
          expiresAt = new Date(Date.now() + rec.cache_hours * 3600_000).toISOString();
        }
        await db.updateTorrentRecord(hash, {
          completed_at: completedAt,
          expires_at: expiresAt,
          total_bytes: live.total_bytes || rec.total_bytes,
        });
        justCompleted.push(hash);
        if (!isGame) {
          triggerProbe = true;
          needsLibraryReload = true;
        }
      }

      // A promoted stream moves on a later poll if it is still being watched at completion.
      // Use persisted paths so a failed move can also be retried after its handle was removed.
      if (!isGame && completedAt && rec.mode === 'download' && savePath && filePaths.some((p) => !isUnder(p, savePath)) && !isPlayingTorrent(filePaths)) {
        try {
          await invoke('torrent_action', { infoHash: hash, action: 'delete_keep_files' });
          const moves: FileMove[] = filePaths.map((from) => ({
            from,
            to: joinPath(savePath, basename(from) || 'video.mkv'),
          }));
          await invoke('apply_moves', { moves });
          await db.updateFilePaths(moves);
          filePaths = moves.map((m) => m.to);
          seedingStopped = true;
          needsLibraryReload = true;
          await db.updateTorrentRecord(hash, { file_paths: filePaths, seeding_stopped: true });
        } catch (e) {
          console.warn('[torrents] post-complete move failed; will retry', e);
        }
      }

      // Check global seed ratio / seed time limits for active seeders
      if (live && live.finished && !seedingStopped) {
        const total = live.total_bytes || rec.total_bytes;
        const ratio = total > 0 ? live.uploaded_bytes / total : 0;
        const ratioReached = settings.torrent_seed_ratio_limit > 0 && ratio >= settings.torrent_seed_ratio_limit;
        const elapsedMins = completedAt ? (Date.now() - Date.parse(completedAt)) / 60_000 : 0;
        const timeReached = settings.torrent_seed_time_mins > 0 && elapsedMins >= settings.torrent_seed_time_mins;
        if (ratioReached || timeReached || rec.delete_on_complete === 1) {
          await stopSeedingHandle(hash, filePaths);
          seedingStopped = true;
          await db.updateTorrentRecord(hash, { seeding_stopped: true });
        }
      }

      // Release handles paused for playback as soon as the viewer leaves that torrent.
      if (live && seedingStopped && !isPlayingTorrent(filePaths)) {
        await invoke('torrent_action', { infoHash: hash, action: 'delete_keep_files' });
      }

      const historyDays = settings.torrent_history_days;
      const historyExpired = historyDays > 0 && completedAt != null && Date.now() - Date.parse(completedAt) >= historyDays * 864e5;
      const filesInLibrary = filePaths.every((p) => isUnder(p, savePath));
      if (rec.mode === 'download' && !failedFileRemovals.has(hash) && historyExpired && filesInLibrary && (!live || (live.finished && seedingStopped)) && !isPlayingTorrent(filePaths)) {
        await db.deleteTorrentRecord(hash);
        continue;
      }

      const totalBytes = live?.total_bytes || rec.total_bytes || 0;
      const finished = live ? live.finished : completedAt != null;
      const progressBytes = live ? live.progress_bytes : finished ? totalBytes : 0;
      const uploadedBytes = live ? live.uploaded_bytes : 0;
      const progressPct = live ? live.progress_pct : finished ? 100 : 0;
      const state: TorrentState = live
        ? seedingStopped && live.finished
          ? 'stopped_seeding'
          : live.state
        : finished
          ? seedingStopped
            ? 'stopped_seeding'
            : 'completed'
          : 'paused';

      merged.push({
        infoHash: hash,
        name: live?.name || rec.name,
        source: rec.source,
        mode: rec.mode,
        purpose: isGame ? 'game' : 'media',
        savePath,
        deleteOnComplete: rec.delete_on_complete === 1,
        cacheHours: rec.cache_hours,
        expiresAt,
        mediaKind: rec.media_kind,
        tmdbId: rec.tmdb_id,
        seriesId: rec.series_id,
        movieId: rec.movie_id,
        filePaths,
        completedAt,
        seedingStopped,
        createdAt: rec.created_at,
        state,
        progressBytes,
        totalBytes,
        uploadedBytes,
        progressPct,
        downloadSpeedBps: live?.download_speed_bps ?? 0,
        uploadSpeedBps: live?.upload_speed_bps ?? 0,
        etaSecs: live?.eta_secs ?? null,
        peersLive: live?.peers_live ?? 0,
        peersConnecting: live?.peers_connecting ?? 0,
        peersSeen: live?.peers_seen ?? 0,
        finished,
        paused: live ? live.paused : true,
        error: live?.error ?? null,
        listenPort: live?.listen_port ?? null,
        files: live?.files ?? [],
        ratio: totalBytes > 0 ? uploadedBytes / totalBytes : 0,
        inSession: !!live && !seedingStopped,
      });

      if (autoPlayQueue.has(hash) && live && live.files.length > 0) {
        autoPlayQueue.delete(hash);
        setTimeout(() => void playTorrentByHash(hash), 50);
      }
    }

    const current = useLibraryStore.getState().torrents;
    const next = reconcileTorrentList(current, merged);
    if (next !== current) useLibraryStore.getState().setTorrents(next);
    merged = next;
    if (needsLibraryReload) await useLibraryStore.getState().reload();
    if (triggerProbe) void startBackgroundAnalysis();
    for (const hash of justCompleted) {
      const item = merged.find((t) => t.infoHash === hash);
      if (item) for (const listener of completionListeners) listener(item);
    }
    return merged;
  })().finally(() => { pollInFlight = null; });
  return pollInFlight;
}

function scheduleAdaptivePoll() {
  if (pollTimer != null) window.clearTimeout(pollTimer);
  const hasActive = useLibraryStore
    .getState()
    .torrents.some((t) => t.inSession && (t.state === 'resolving' || t.state === 'initializing' || t.state === 'downloading' || t.state === 'seeding'));
  // Nobody is watching progress bars while the window is hidden; completion still lands within 6 s.
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const interval = hasActive && !hidden ? 1500 : 6000;
  pollTimer = window.setTimeout(async () => {
    try {
      await pollTorrents();
    } catch (e) {
      console.warn('[torrents] poll failed', e);
    } finally {
      scheduleAdaptivePoll();
    }
  }, interval);
}

export async function reapExpiredStreams() {
  const store = useLibraryStore.getState();
  const records = await db.listTorrentRecords();
  const now = Date.now();

  for (const r of records) {
    if (r.mode !== 'stream' || !r.expires_at) continue;
    const exp = Date.parse(r.expires_at);
    if (!Number.isFinite(exp) || exp > now) continue;

    let paths: string[] = [];
    try {
      paths = JSON.parse(r.file_paths) as string[];
    } catch {
      paths = [];
    }
    if (isPlayingTorrent(paths)) continue; // never delete while actively watching!

    if (removalsInProgress.has(r.info_hash.toLowerCase())) continue;
    try {
      await removeTorrent(r.info_hash, true);
      store.toast(`Stream cache expired & cleared: “${r.name}”`, 'info');
    } catch (e) {
      console.warn('[torrents] stream cache cleanup failed; will retry', e);
    }
  }
}

// ---------------------------------------------------------------------------
// OS Deep-Link (`magnet:`), `.torrent` File Open, and Drag-and-Drop Listeners
// ---------------------------------------------------------------------------

function handleIncomingTorrentLink(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  if (trimmed.toLowerCase().startsWith('magnet:') || trimmed.toLowerCase().endsWith('.torrent') || trimmed.startsWith('file://')) {
    useLibraryStore.getState().openAddTorrent(trimmed);
  }
}

export async function fileToBase64TorrentSource(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `base64:${btoa(binary)}`;
}

let initialized = false;

export async function initTorrentService() {
  if (initialized) return;
  initialized = true;

  await syncTorrentEngineConfig();
  try {
    await reapExpiredStreams();
    await pollTorrents();
  } catch (e) {
    console.warn('[torrents] initial poll failed', e);
  } finally {
    scheduleAdaptivePoll();
  }

  window.setInterval(() => {
    void reapExpiredStreams();
  }, 30_000);

  // Subscribe to settings changes so rate limits & network flags apply live!
  useLibraryStore.subscribe((state, prev) => {
    if (state.settings !== prev.settings) {
      void syncTorrentEngineConfig(state.settings);
    }
  });

  // Listen for magnet metadata resolution & OS file/magnet open events
  const u1 = await listen<TorrentStatus>('torrent-metadata-ready', () => {
    void pollTorrents();
  }).catch(() => null);
  if (u1) unlisteners.push(u1);

  const u2 = await listen<string>('torrent-open-link', ({ payload }) => {
    handleIncomingTorrentLink(payload);
  }).catch(() => null);
  if (u2) unlisteners.push(u2);

  try {
    const u3 = await onOpenUrl((urls) => {
      for (const u of urls) handleIncomingTorrentLink(u);
    });
    unlisteners.push(u3);
  } catch {
    /* deep-link listener optional in browser mock */
  }

  // Drain any cold-start magnet or .torrent links
  try {
    const pending = await invoke<string[]>('torrent_take_pending_links');
    if (pending.length) handleIncomingTorrentLink(pending[pending.length - 1]);
  } catch {
    /* ignore */
  }
  try {
    const initialUrls = await getDeepLinkCurrent();
    if (initialUrls?.length) handleIncomingTorrentLink(initialUrls[initialUrls.length - 1]);
  } catch {
    /* ignore */
  }
}
