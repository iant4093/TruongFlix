import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { BrowseTarget, SourceEvent, SourceRelease } from '../types/browse';
import type { InspectTorrentRes, TorrentMode } from '../types/media';
import type { SearchResult } from './tmdb';
import { episodeTarget, seriesPlayEpisode } from '../store/selectors';
import { play } from './player';
import { parseMediaInfo } from './mediainfo';
import { advertisedQuality, check, type Release } from './browseSelection';
import { formatBytes, initiateTorrent, inspectTorrentFilesLive, pickDestinationFolder, playTorrentByHash } from './torrents';

export const canceled = () => new DOMException('Canceled', 'AbortError');
const abort = (signal: AbortSignal) => { if (signal.aborted) throw canceled(); };
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  abort(signal);
  return new Promise((resolve, reject) => {
    const stop = () => reject(canceled());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
export function validateSourceUrl(raw: string) {
  const url = new URL(raw.trim());
  const host = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.split('.').every((p) => /^\d+$/.test(p))) {
    throw new Error('Enter the public HTTPS address of your source website.');
  }
  return url.origin;
}

class SourceSession {
  readonly id = crypto.randomUUID();
  private unlisten: UnlistenFn | null = null;
  private queue: SourceEvent[] = [];
  private waiter: ((e: SourceEvent) => void) | null = null;
  private closed = false;
  private page = 1;
  constructor(readonly signal: AbortSignal, private onEvent?: (event: SourceEvent) => void) {}
  async open(sourceUrl: string, imdbId: string, manual: boolean) {
    abort(this.signal);
    this.signal.addEventListener('abort', this.close, { once: true });
    this.unlisten = await listen<SourceEvent>('source-browser', ({ payload }) => {
      if (payload.requestId !== this.id || this.closed || this.signal.aborted) return;
      if (!manual && payload.kind === 'results' && (payload.page ?? 1) !== this.page) return;
      this.onEvent?.(payload);
      if (this.waiter) this.waiter(payload);
      else if (!manual || ['ready', 'error', 'closed'].includes(payload.kind)) this.queue.push(payload);
    });
    if (this.signal.aborted) { this.unlisten?.(); this.close(); throw canceled(); }
    try {
      await invoke('source_browser_open', { requestId: this.id, sourceUrl: validateSourceUrl(sourceUrl), imdbId, manual });
      abort(this.signal);
    } catch (e) { this.close(); throw e; }
  }
  control(action: string, releaseId?: string, page?: number) {
    abort(this.signal);
    if (action === 'page' && page != null) this.page = page;
    return invoke('source_browser_control', { requestId: this.id, action, releaseId: releaseId ?? null, page: page ?? null });
  }
  async wait(kind: SourceEvent['kind'], timeout = 60_000, matches: (event: SourceEvent) => boolean = () => true): Promise<SourceEvent> {
    abort(this.signal);
    const consume = (e: SourceEvent) => {
      if (e.kind === 'error') throw new Error(e.message || 'The source browser could not complete this request.');
      if (e.kind === 'closed') throw canceled();
      return e.kind === kind && matches(e);
    };
    while (this.queue.length) { const e = this.queue.shift()!; if (consume(e)) return e; }
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.signal.removeEventListener('abort', stop); this.waiter = null; };
      const stop = () => { cleanup(); reject(canceled()); };
      const timer = window.setTimeout(() => { cleanup(); reject(new Error('The source took too long. Complete any verification in the title dialog, or browse torrents manually.')); }, timeout);
      this.signal.addEventListener('abort', stop, { once: true });
      this.waiter = (e) => {
        try { if (consume(e)) { cleanup(); resolve(e); } }
        catch (error) { cleanup(); reject(error); }
      };
    });
  }
  close = () => {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.close);
    this.unlisten?.(); this.unlisten = null;
    void invoke('source_browser_control', { requestId: this.id, action: 'close', releaseId: null, page: null }).catch(() => {});
  };
}

let activeController: AbortController | null = null;
export function cancelSourceBrowser() { activeController?.abort(); activeController = null; }
export interface SourceBrowserSession {
  requestId: string;
  control: (action: 'back' | 'forward' | 'reload') => Promise<unknown>;
  close: () => void;
}
export interface SourceBrowserOptions {
  signal?: AbortSignal;
  onSelected?: () => void;
  onClosed?: () => void;
  onError?: (message: string) => void;
}
export async function browseSource(item: SearchResult, imdbId: string, sourceUrl: string, options: SourceBrowserOptions = {}): Promise<SourceBrowserSession> {
  const profile = useLibraryStore.getState().activeProfile?.id;
  const permitted = () => { const state = useLibraryStore.getState(); return !!profile && state.activeProfile?.id === profile && state.activeProfile.maturity === 'all' && !state.profileGate; };
  if (!permitted()) throw canceled();
  cancelSourceBrowser();
  const controller = new AbortController(); activeController = controller;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  let selecting = false;
  const session = new SourceSession(controller.signal, (e) => {
    if (!permitted()) { controller.abort(); return; }
    if (e.kind === 'magnet' && e.magnet) {
      if (selecting) return;
      selecting = true;
      const magnet = e.magnet;
      // Remove the native view before presenting the trusted torrent-review controls beneath it.
      void invoke('source_browser_place', { requestId: session.id, rect: null }).catch(() => {}).then(() => {
        if (controller.signal.aborted || !permitted()) { controller.abort(); return; }
        controller.abort();
        options.onSelected?.();
        useLibraryStore.getState().openAddTorrent(magnet, item);
      });
    } else if (e.kind === 'closed') controller.abort();
    else if (e.kind === 'error') {
      const message = e.message || 'Source browser error';
      if (options.onError) options.onError(message); else useLibraryStore.getState().toast(message, 'error');
    }
  });
  controller.signal.addEventListener('abort', () => {
    session.close(); options.signal?.removeEventListener('abort', cancel);
    if (activeController === controller) activeController = null;
    options.onClosed?.();
  }, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    await session.open(sourceUrl, imdbId, true); await session.wait('ready', 30_000);
    abort(controller.signal);
    return { requestId: session.id, close: cancel, control: async (action) => {
      if (!permitted()) { controller.abort(); throw canceled(); }
      return session.control(action);
    } };
  } catch (e) { controller.abort(); throw e; }
}

export function candidateMatches(target: BrowseTarget, row: SourceRelease) {
  // These are only preliminary advertised-label checks. Exact file coverage is checked after metadata resolution.
  if (row.imdbId !== target.imdbId || row.seeders == null || !Number.isFinite(row.seeders)
      || row.seeders <= 0 || advertisedQuality(row.title) !== target.quality) return false;
  if (target.kind === 'movie') return true;
  const name = row.title.replace(/_/g, '.');
  if (/\bComplete[ .-]*(?:Series|Collection)\b|\bS\d{1,2}[ .-]*-[ .-]*S?\d{1,2}\b/i.test(name)) return false;
  const season = name.match(/\bS(\d{1,2})(?=[ .-]?E\d|\b)|\bSeason[ .-]*(\d{1,2})\b/i);
  if (Number(season?.[1] ?? season?.[2]) !== target.season) return false;
  if (target.kind === 'episode') {
    const ep = name.match(/\bS\d{1,2}[ .-]?E(\d{1,3})(?!\d)/i);
    if (!ep || Number(ep[1]) !== target.episode) return false;
    const suffix = name.slice(ep.index! + ep[0].length);
    return !/^[ .-]*E\d|^[ .]*-[ .]*\d{1,3}\b|\bS\d{1,2}[ .-]?E\d/i.test(suffix);
  }
  return !/\bS\d{1,2}[ .-]?E\d{1,3}/i.test(name);
}


export async function useOwnedTitle(item: SearchResult, target: BrowseTarget, mode: TorrentMode, signal: AbortSignal): Promise<boolean> {
  const state = useLibraryStore.getState();
  const quality = (row: { raw_filename: string; media_info: string | null }) => {
    const info = parseMediaInfo(row.media_info);
    if (info?.width && info.height) {
      const actual = (info.width >= 3600 && info.width <= 4300) || (info.height >= 2000 && info.height <= 2200) ? '4K'
        : (info.width >= 1800 && info.width <= 2100) || (info.height >= 1000 && info.height <= 1100) ? '1080p' : null;
      return actual === target.quality && !/\b1080i\b/i.test(row.raw_filename);
    }
    return target.quality === '4K' ? /\b(?:2160p|4k)\b/i.test(row.raw_filename.replace(/_/g, '.')) : /\b1080p\b/i.test(row.raw_filename.replace(/_/g, '.'));
  };
  const movie = target.kind === 'movie' ? state.movies.find((m) => m.tmdb_id === item.id && quality(m)) : null;
  const series = target.kind !== 'movie' ? state.series.find((s) => s.tmdb_id === item.id) : null;
  const episodes = series && target.kind !== 'movie' ? state.episodes.filter((e) => e.series_id === series.id
    && e.season_number === target.season && quality(e)
    && (target.kind === 'season' ? target.expected.includes(e.episode_number) : e.episode_number === target.episode)) : [];
  const covered = target.kind === 'season' ? target.complete && target.expected.length > 0
    && target.expected.every((ep) => episodes.some((e) => e.episode_number === ep)) : episodes.length > 0;
  const paths = movie ? [movie.file_path] : covered ? episodes.map((e) => e.file_path) : [];
  if (!paths.length) return false;
  const accessible = await invoke<boolean[]>('check_paths', { paths }).catch(() => []);
  abort(signal);
  const current = useLibraryStore.getState();
  if (current.activeProfile?.id !== state.activeProfile?.id || current.activeProfile?.maturity !== 'all' || current.profileGate) throw canceled();
  if (accessible.length !== paths.length || !accessible.every(Boolean)) return false;
  if (mode === 'download') { state.toast('This selection is already in your library.', 'info'); return true; }
  if (movie) {
    await play({ type: 'movie', id: movie.id, filePath: movie.file_path, startTime: movie.watched ? 0 : movie.progress_seconds, label: movie.title });
  } else {
    const ep = seriesPlayEpisode(episodes);
    if (ep) await play(episodeTarget(ep, { title: series!.title }));
  }
  return true;
}

export interface ReleaseSearchOptions {
  target: BrowseTarget; sourceUrl: string;
  signal: AbortSignal; progress: (message: string) => void;
  verification?: (requestId: string | null) => void;
}

export interface QuickOptions extends ReleaseSearchOptions {
  item: SearchResult;
  mode: TorrentMode;
  release?: SourceRelease;
}

const SOURCE_PAGES = 3;
const SOURCE_PAGE_SIZE = 50;
const RELEASE_PICKER_LIMIT = 5;

async function withSource<T>(opts: ReleaseSearchOptions, run: (session: SourceSession, signal: AbortSignal, valid: () => void) => Promise<T>) {
  cancelSourceBrowser();
  const controller = new AbortController(); activeController = controller;
  const cancel = () => controller.abort(); opts.signal.addEventListener('abort', cancel, { once: true });
  if (opts.signal.aborted) controller.abort();
  const signal = controller.signal;
  const profile = useLibraryStore.getState().activeProfile?.id;
  const valid = () => {
    abort(signal);
    const s = useLibraryStore.getState();
    if (s.activeProfile?.id !== profile || s.activeProfile?.maturity !== 'all' || s.profileGate) throw canceled();
  };
  const session = new SourceSession(signal, (event) => {
    if (event.kind === 'challenge') { opts.verification?.(session.id); opts.progress('Complete the verification below to continue.'); }
    if (event.kind === 'results') { opts.verification?.(null); opts.progress('Finding releases for your selection…'); }
  });
  try { return await run(session, signal, valid); }
  finally {
    opts.verification?.(null); session.close(); opts.signal.removeEventListener('abort', cancel);
    if (activeController === controller) activeController = null;
  }
}

function requireCompleteSeason(target: BrowseTarget) {
  if (target.kind === 'season' && !target.complete) throw new Error('This season’s completeness is uncertain. Choose an episode or browse torrents manually.');
}

async function sourcePage(session: SourceSession, page: number) {
  if (page > 1) await session.control('page', undefined, page);
  const result = await session.wait('results', 90_000, (event) => (event.page ?? 1) === page);
  return result.releases ?? [];
}

/** Rank advertised matches only. The selected release's files are verified before a transfer starts. */
export async function searchTorrentReleases(opts: ReleaseSearchOptions): Promise<SourceRelease[]> {
  requireCompleteSeason(opts.target);
  return withSource(opts, async (session, _signal, valid) => {
    valid();
    opts.progress('Searching your source…');
    await session.open(opts.sourceUrl, opts.target.imdbId, false);
    const releases = new Map<string, SourceRelease>();
    for (let page = 1; page <= SOURCE_PAGES; page++) {
      valid();
      const rows = await sourcePage(session, page);
      valid();
      for (const row of rows) {
        if (!releases.has(row.id) && candidateMatches(opts.target, row)) releases.set(row.id, row);
      }
      if (rows.length < SOURCE_PAGE_SIZE) break;
    }
    return [...releases.values()].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0)).slice(0, RELEASE_PICKER_LIMIT);
  });
}

/** Metadata verification is bounded and never starts a payload transfer after cancellation. */
export async function quickTorrent(opts: QuickOptions) {
  return withSource(opts, async (session, signal, valid) => {
    valid();
    if (!opts.release && await useOwnedTitle(opts.item, opts.target, opts.mode, signal)) return;
    valid();
    const settings = useLibraryStore.getState().settings;
    const destination = pickDestinationFolder(opts.item.kind, settings);
    if (opts.mode === 'download' && !destination) throw new Error('Add a library folder in Settings before downloading.');
    requireCompleteSeason(opts.target);
    opts.progress('Searching your source…');
    await session.open(opts.sourceUrl, opts.target.imdbId, false);
    let attempts = 0;
    let resolved = 0;
    const tried = new Set<string>();
    const hashes = new Set<string>();
    for (let page = 1; page <= SOURCE_PAGES && attempts < 6; page++) {
      valid();
      const rows = await sourcePage(session, page);
      const candidates = rows.filter((row) => candidateMatches(opts.target, row)
        && (!opts.release || (opts.release.id === row.id && opts.release.title === row.title)))
        .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
      for (const row of candidates) {
        valid();
        if (tried.has(row.id)) continue;
        if (++attempts > 6) break;
        tried.add(row.id);
        opts.progress(opts.release ? `Verifying ${row.title}…` : `Checking release ${attempts} of 6: ${row.title}`);
        await session.control('capture', row.id);
        const capture = await session.wait('magnet', 12_000, (event) => event.releaseId === row.id);
        valid();
        if (!capture.magnet) continue;
        let inspected: InspectTorrentRes;
        try { inspected = await abortable(inspectTorrentFilesLive(capture.magnet, 8000), signal); }
        catch { valid(); continue; }
        valid();
        if (inspected.metadata_ready) resolved++;
        const hash = inspected.info_hash.toLowerCase();
        if (hashes.has(hash)) continue;
        hashes.add(hash);
        const release: Release = { ...row, metadataReady: inspected.metadata_ready,
          files: inspected.files.map((f) => ({ index: f.index, path: f.relative_path, video: f.is_video })) };
        const verified = check(opts.target, release);
        if (!verified.ok) continue;
        const existing = useLibraryStore.getState().torrents.find((t) => t.infoHash.toLowerCase() === inspected.info_hash.toLowerCase());
        if (existing) {
          session.close();
          if (opts.mode === 'stream') await playTorrentByHash(existing.infoHash);
          else useLibraryStore.getState().toast('This release is already in your transfers.', 'info');
          return;
        }
        await session.control('hide');
        valid();
        if (opts.target.kind === 'season') {
          const pending = useLibraryStore.getState().confirm({ title: `Season ${opts.target.season}`, message: `${row.title}\n${verified.indices.length} episodes · ${formatBytes(inspected.total_bytes)}\n${opts.mode === 'stream' ? 'The selected season pack will use the stream cache.' : `Download to ${destination}.`}`, confirmLabel: opts.mode === 'stream' ? 'Stream season' : 'Download season' });
          const request = useLibraryStore.getState().confirmRequest;
          const dismiss = () => { const store = useLibraryStore.getState(); if (store.confirmRequest === request) store.resolveConfirm(false); };
          signal.addEventListener('abort', dismiss, { once: true });
          let ok: boolean;
          try { ok = await abortable(pending, signal); }
          finally { signal.removeEventListener('abort', dismiss); }
          valid(); if (!ok) throw canceled();
        }
        opts.progress(opts.mode === 'stream' ? 'Preparing playback…' : 'Starting download…');
        valid();
        await initiateTorrent({ source: capture.magnet, name: inspected.name, mode: opts.mode, destinationRoot: destination,
          deleteOnComplete: settings.torrent_delete_after_complete, cacheHours: settings.torrent_stream_cache_hours,
          onlyFiles: verified.indices, match: opts.item, fallbackKind: opts.item.kind, fallbackTitle: opts.item.title,
          fallbackYear: opts.item.year, abortSignal: signal, playImmediately: opts.mode === 'stream' });
        return;
      }
      if ((opts.release && attempts > 0) || rows.length < SOURCE_PAGE_SIZE) break;
    }
    if (opts.release) {
      if (!attempts) throw new Error('This release changed or is no longer on the source page. Search again to refresh the list.');
      if (!resolved) throw new Error('The selected release’s file metadata was unavailable. Try another release.');
      throw new Error('The selected release’s files did not match this title, quality, or episode selection. Try another release.');
    }
    const reason = !attempts ? 'The source had no seeded releases advertising this quality and selection.'
      : !resolved ? `Checked ${attempts} releases, but their file metadata was unavailable.`
      : `Checked ${attempts} releases; their files did not match this title, quality, or episode selection.`;
    throw new Error(`No verified release matched this quality and selection. ${reason} Browse torrents to choose another release.`);
  });
}
