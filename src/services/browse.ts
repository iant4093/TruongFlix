import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { BrowseTarget, SourceEvent, SourceRelease } from '../types/browse';
import type { InspectTorrentRes, TorrentMode } from '../types/media';
import type { SearchResult } from './tmdb';
import { episodeTarget, seriesPlayEpisode } from '../store/selectors';
import { play } from './player';
import { parseMediaInfo } from './mediainfo';
import { check, type Release } from './browseSelection';
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
  constructor(readonly signal: AbortSignal, private onEvent?: (event: SourceEvent) => void) {}
  async open(sourceUrl: string, imdbId: string, manual: boolean) {
    abort(this.signal);
    this.signal.addEventListener('abort', this.close, { once: true });
    this.unlisten = await listen<SourceEvent>('source-browser', ({ payload }) => {
      if (payload.requestId !== this.id || this.closed || this.signal.aborted) return;
      this.onEvent?.(payload);
      if (this.waiter) this.waiter(payload); else this.queue.push(payload);
    });
    if (this.signal.aborted) { this.unlisten?.(); this.close(); throw canceled(); }
    try {
      await invoke('source_browser_open', { requestId: this.id, sourceUrl: validateSourceUrl(sourceUrl), imdbId, manual });
      abort(this.signal);
    } catch (e) { this.close(); throw e; }
  }
  control(action: string, releaseId?: string, page?: number) {
    abort(this.signal);
    return invoke('source_browser_control', { requestId: this.id, action, releaseId: releaseId ?? null, page: page ?? null });
  }
  async wait(kind: SourceEvent['kind'], timeout = 60_000): Promise<SourceEvent> {
    abort(this.signal);
    const consume = (e: SourceEvent) => {
      if (e.kind === 'error') throw new Error(e.message || 'The source browser could not complete this request.');
      if (e.kind === 'closed') throw canceled();
      return e.kind === kind;
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
export async function browseSource(item: SearchResult, imdbId: string, sourceUrl: string, onSelected?: () => void) {
  const profile = useLibraryStore.getState().activeProfile?.id;
  const permitted = () => { const state = useLibraryStore.getState(); return !!profile && state.activeProfile?.id === profile && state.activeProfile.maturity === 'all' && !state.profileGate; };
  if (!permitted()) throw canceled();
  cancelSourceBrowser();
  const controller = new AbortController(); activeController = controller;
  const session = new SourceSession(controller.signal, (e) => {
    if (!permitted()) { session.close(); return; }
    if (e.kind === 'magnet' && e.magnet) {
      session.close();
      onSelected?.();
      useLibraryStore.getState().openAddTorrent(e.magnet, item);
    } else if (e.kind === 'closed') session.close();
    else if (e.kind === 'error') useLibraryStore.getState().toast(e.message || 'Source browser error', 'error');
  });
  try { await session.open(sourceUrl, imdbId, true); await session.wait('ready', 30_000); }
  catch (e) { session.close(); throw e; }
}

export function candidateMatches(target: BrowseTarget, row: SourceRelease) {
  // These are only preliminary advertised-label checks. Exact file coverage is checked after metadata resolution.
  const quality = target.quality === '4K' ? /\b(?:2160p|4k|uhd)\b/i : /\b1080p\b/i;
  if (row.imdbId !== target.imdbId || !(row.seeders != null && row.seeders > 0) || !quality.test(row.title.replace(/_/g, '.'))) return false;
  if (target.kind === 'movie') return true;
  const season = row.title.match(/\bS(\d{1,2})(?=[ ._-]?E\d|\b)|\bSeason[ ._-]*(\d{1,2})\b/i);
  if (Number(season?.[1] ?? season?.[2]) !== target.season) return false;
  if (target.kind === 'episode') {
    const ep = row.title.match(/\bS\d{1,2}[ ._-]?E(\d{1,3})(?!\d)/i);
    return Number(ep?.[1]) === target.episode;
  }
  return !/\bS\d{1,2}[ ._-]?E\d{1,3}/i.test(row.title);
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

export interface QuickOptions {
  item: SearchResult; target: BrowseTarget; mode: TorrentMode; sourceUrl: string;
  signal: AbortSignal; progress: (message: string) => void;
  verification?: (requestId: string | null) => void;
}

/** Metadata verification is bounded and never starts a payload transfer after cancellation. */
export async function quickTorrent(opts: QuickOptions) {
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
  try {
    valid();
    if (await useOwnedTitle(opts.item, opts.target, opts.mode, signal)) return;
    valid();
    const settings = useLibraryStore.getState().settings;
    const destination = pickDestinationFolder(opts.item.kind, settings);
    if (opts.mode === 'download' && !destination) throw new Error('Add a library folder in Settings before downloading.');
    if (opts.target.kind === 'season' && !opts.target.complete) throw new Error('This season’s completeness is uncertain. Choose an episode or browse torrents manually.');
    opts.progress('Searching your source…');
    await session.open(opts.sourceUrl, opts.target.imdbId, false);
    let attempts = 0;
    let resolved = 0;
    const tried = new Set<string>();
    const hashes = new Set<string>();
    for (let page = 1; page <= 3 && attempts < 6; page++) {
      valid();
      if (page > 1) await session.control('page', undefined, page);
      const event = await session.wait('results', 90_000);
      const candidates = (event.releases ?? []).filter((r) => candidateMatches(opts.target, r)).sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
      if (!event.releases?.length) break;
      for (const row of candidates) {
        valid();
        if (tried.has(row.id)) continue;
        if (++attempts > 6) break;
        tried.add(row.id);
        opts.progress(`Checking release ${attempts} of 6: ${row.title}`);
        await session.control('capture', row.id);
        let capture: SourceEvent;
        try { capture = await session.wait('magnet', 12_000); }
        catch (e) { valid(); throw e; }
        valid();
        if (!capture.magnet || capture.releaseId !== row.id) continue;
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
      if ((event.releases?.length ?? 0) < 50) break;
    }
    const reason = !attempts ? 'The source had no seeded releases advertising this quality and selection.'
      : !resolved ? `Checked ${attempts} releases, but their file metadata was unavailable.`
      : `Checked ${attempts} releases; their files did not match this title, quality, or episode selection.`;
    throw new Error(`No verified release matched this quality and selection. ${reason} Browse torrents to choose another release.`);
  } finally {
    opts.verification?.(null); session.close(); opts.signal.removeEventListener('abort', cancel);
    if (activeController === controller) activeController = null;
  }
}
