import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import { httpMusicApi, playableCodecs, type MusicApi } from '../music/api';
import { loadMusicLibrary } from '../music/actions';
import { initMusicPlayer, pause, stopMusic, useMusicPlayer } from '../music/player';
import type { MusicLyrics, MusicStream } from '../music/types';
import { registerStream, releaseStream, streamUrl } from './streaming';
import * as mdb from './musicdb';

/**
 * The desktop side of Music: scanning the music folders, lyrics (from the files, or LRCLIB),
 * streams for the player, and the `MusicApi` the desktop screens use.
 */

const LYRICS_RETRY_MS = 14 * 86400_000;

export const looksSynced = (text: string) => /^\s*\[\d{1,3}:\d{1,2}/m.test(text);

interface OnlineLyrics {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}

const lyricsInFlight = new Map<number, Promise<MusicLyrics | null>>();

function fromCache(c: mdb.CachedLyrics): MusicLyrics | null {
  if (c.synced) return { text: c.synced, synced: true, source: 'lrclib', instrumental: c.instrumental };
  if (c.instrumental) return { text: '', synced: false, source: 'lrclib', instrumental: true };
  if (c.plain) return { text: c.plain, synced: false, source: 'lrclib' };
  return null;
}

/**
 * Lyrics for a song: synced lyrics from the file (sidecar .lrc or embedded) first, then LRCLIB
 * (when allowed in Settings, looked up once and cached), then the file's plain lyrics.
 */
export function lyricsFor(trackId: number, online = useLibraryStore.getState().settings.music_lyrics_online): Promise<MusicLyrics | null> {
  const running = lyricsInFlight.get(trackId);
  if (running) return running;
  const job = (async (): Promise<MusicLyrics | null> => {
    const row = await mdb.musicTrackFile(trackId);
    if (!row) return null;
    const own: MusicLyrics | null = row.lyrics ? { text: row.lyrics, synced: looksSynced(row.lyrics), source: row.lyrics_source === 'sidecar' ? 'sidecar' : 'embedded' } : null;
    if (own?.synced) return own;
    const cached = await mdb.cachedLyrics(trackId);
    if (cached && (cached.synced || cached.plain || cached.instrumental || Date.now() - cached.fetched_at < LYRICS_RETRY_MS)) {
      const hit = fromCache(cached);
      return hit?.synced ? hit : own ?? hit;
    }
    if (!online) return own;
    let found: OnlineLyrics | null;
    try {
      found = await invoke<OnlineLyrics | null>('music_lyrics_fetch', { artist: row.artist, title: row.title, album: row.album, duration: row.duration });
    } catch (e) {
      console.warn('[music] lyrics lookup failed', e);
      return own; // offline: try again next time
    }
    await mdb.saveLyricsCache(trackId, found ?? { synced: null, plain: null, instrumental: false });
    const hit = found ? fromCache({ ...found, fetched_at: Date.now() }) : null;
    return hit?.synced ? hit : own ?? hit;
  })().finally(() => lyricsInFlight.delete(trackId));
  lyricsInFlight.set(trackId, job);
  return job;
}

const CONVERTIBLE = new Set(['mp3', 'flac', 'aac', 'alac', 'vorbis', 'opus', 'wav', 'aiff', 'wavpack', 'ape', 'musepack', 'speex']);

/** Registers a song with the media server: the original file, or an AAC conversion when `codecs` can't play it. */
export async function registerMusicStream(trackId: number, codecs: string[]): Promise<{ token: string; transcoded: boolean } | null> {
  const row = await mdb.musicTrackFile(trackId);
  if (!row) return null;
  const codec = row.codec ?? '';
  const transcoded = !codecs.includes(codec) && (CONVERTIBLE.has(codec) || !codec || codec === 'unknown');
  const token = await registerStream(row.file_path, { format: transcoded ? 'aac' : 'direct', width: 0, height: 0, tone_map: false, aid: null, sid: null, sub_style: [] });
  return { token, transcoded };
}

/** Keeps the few most recent music streams of one listener (current + preloaded next). */
export class StreamRing {
  private tokens: string[] = [];
  constructor(private keep = 3) {}
  add(token: string) {
    this.tokens.push(token);
    while (this.tokens.length > this.keep) releaseStream(this.tokens.shift()!);
  }
  clear() {
    for (const t of this.tokens) releaseStream(t);
    this.tokens = [];
  }
}

const desktopStreams = new StreamRing();
let serverPort = 0;
let codecs: string[] | null = null;

async function desktopStream(trackId: number): Promise<MusicStream> {
  const reg = await registerMusicStream(trackId, (codecs ??= playableCodecs()));
  if (!reg) throw new Error('This song is no longer in your library');
  desktopStreams.add(reg.token);
  const url = await streamUrl(reg.token, 0, '127.0.0.1');
  serverPort = Number(new URL(url.url).port) || serverPort;
  return { url: url.url, transcoded: reg.transcoded };
}

/** Cover URL for the system media controls (served by the media server). */
export function musicCoverForSystem(art: string | null): string | null {
  return art && serverPort ? `http://127.0.0.1:${serverPort}/music-art/${art}` : null;
}

const profileId = () => {
  const p = useLibraryStore.getState().activeProfile;
  if (!p) throw new Error('Pick a profile first');
  return p.id;
};

function localApi(artDir: string): MusicApi {
  const sep = artDir.includes('\\') ? '\\' : '/';
  return {
    library: () => mdb.loadMusic(profileId()),
    lyrics: (id) => lyricsFor(id),
    stream: (track) => desktopStream(track.id),
    played: async (id) => {
      await mdb.recordPlay(profileId(), id);
    },
    setFavourite: async (id, value) => {
      await mdb.setFavourite(profileId(), id, value);
    },
    createPlaylist: (name, ids = []) => mdb.createPlaylist(profileId(), name, ids),
    renamePlaylist: (id, name) => mdb.renamePlaylist(profileId(), id, name),
    deletePlaylist: (id) => mdb.deletePlaylist(profileId(), id),
    setPlaylistTracks: async (id, ids) => {
      await mdb.setPlaylistTracks(profileId(), id, ids);
    },
    addToPlaylist: async (id, ids) => {
      await mdb.addToPlaylist(profileId(), id, ids);
    },
    artUrl: (art) => (art ? convertFileSrc(`${artDir}${sep}${art}`) : null),
  };
}

let started = false;

/** Sets up the player for the desktop app (call once at startup). */
export async function initDesktopMusic() {
  if (started) return;
  started = true;
  const preview = import.meta.env.DEV && (window as { __TF_DESKTOP_MOCK__?: boolean }).__TF_DESKTOP_MOCK__;
  if (preview) {
    const { mockMusicRoute, mockArtUrl } = await import('../music/mock');
    const api = httpMusicApi(async <T,>(path: string, init?: { method?: string; body?: unknown }) => {
      const url = new URL(path, 'http://x');
      const [status, data] = mockMusicRoute(init?.method ?? 'GET', url.pathname, url.searchParams, (init?.body as Record<string, unknown>) ?? {});
      if (status !== 200) throw new Error((data as { error?: string }).error ?? 'Failed');
      return data as T;
    }, { id: 1 });
    api.artUrl = mockArtUrl;
    initMusicPlayer(api);
  } else {
    const dir = await invoke<string>('music_art_dir');
    initMusicPlayer(localApi(dir));
  }
  // A different profile has its own favourites, plays and playlists.
  useLibraryStore.subscribe((s, prev) => {
    if (s.activeProfile?.id !== prev.activeProfile?.id) {
      stopMusic();
      desktopStreams.clear();
      if (useMusicPlayer.getState().library) void loadMusicLibrary(true);
    }
    // Starting a video pauses the music.
    if (s.playerSession && !prev.playerSession && useMusicPlayer.getState().playing) pause();
  });
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export interface MusicScanResult {
  seen: string[];
  changed: mdb.MusicFile[];
}

const isUnder = (path: string, root: string) => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(`${r}/`);
};

/** Files to drop: gone from a reachable folder, or in a folder no longer in the list. */
export function goneMusicPaths(indexed: string[], seen: Set<string>, dirs: string[], offline: string[]): string[] {
  return indexed.filter((p) => {
    if (!dirs.some((d) => isUnder(p, d))) return true;
    if (offline.some((d) => isUnder(p, d))) return false;
    return !seen.has(p);
  });
}

let scanning = false;

/** Reads new and changed songs in the music folders; runs alongside the video scan. */
export async function runMusicScan(opts: { force?: boolean; quiet?: boolean } = {}) {
  if (scanning) return;
  const { settings, toast } = useLibraryStore.getState();
  const dirs = settings.music_directories ?? [];
  scanning = true;
  try {
    const index = await mdb.musicFileIndex();
    if (!dirs.length && !index.size) return;
    const reachable = dirs.length ? await invoke<boolean[]>('check_paths', { paths: dirs }) : [];
    const roots = dirs.filter((_, i) => reachable[i]);
    const offline = dirs.filter((_, i) => !reachable[i]);
    const known: Record<string, number> = {};
    for (const [path, rec] of index) known[path] = rec.mtime;
    const res = roots.length ? await invoke<MusicScanResult>('music_scan', { paths: roots, known, force: !!opts.force }) : { seen: [], changed: [] };
    const added = res.changed.filter((f) => !index.has(f.file_path)).length;
    await mdb.upsertMusicFiles(res.changed);
    const gone = goneMusicPaths([...index.keys()], new Set(res.seen), dirs, offline);
    await mdb.removeMusicPaths(gone);
    if (!gone.length && res.changed.length) await mdb.pruneMusic();
    if (res.changed.length || gone.length) await loadMusicLibrary(true);
    if (!opts.quiet && (added || gone.length || res.changed.length)) {
      const updated = res.changed.length - added;
      toast(`Music: ${[`${added} song${added === 1 ? '' : 's'} added`, updated ? `${updated} updated` : '', gone.length ? `${gone.length} removed` : ''].filter(Boolean).join(' · ')}`, 'success');
    }
    if (offline.length && !opts.quiet) toast(`Offline music folder skipped: ${offline.join(', ')}`, 'error');
  } catch (e) {
    console.error('[music] scan failed', e);
    if (!opts.quiet) toast(`Music scan failed: ${String(e)}`, 'error');
  } finally {
    scanning = false;
  }
}
