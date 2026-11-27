import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { useLibraryStore } from '../store/useLibraryStore';
import { httpMusicApi, playableCodecs, type MusicApi } from '../music/api';
import { loadMusicLibrary } from '../music/actions';
import { initMusicPlayer, pause, stopMusic, useMusicPlayer } from '../music/player';
import type { MusicLyrics, MusicStream } from '../music/types';
import { registerStream, releaseStream, streamUrl } from './streaming';
import * as mdb from './musicdb';
import { pairMoved } from '../lib/relink';

/**
 * The desktop side of Music: scanning the music folders, lyrics (from the files, or Kugou / NetEase / LRCLIB),
 * streams for the player, and the `MusicApi` the desktop screens use.
 */

/** A song the lyrics services didn't have is looked up again after this long (new lyrics get added all the time). */
const LYRICS_RETRY_MS = 3 * 86400_000;

export const looksSynced = (text: string) => /^\s*\[\d{1,3}:\d{1,2}/m.test(text);

interface OnlineLyrics {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  provider: 'kugou' | 'netease' | 'lrclib';
}

/**
 * Bumped when the online lookup gets better, so songs looked up before are looked up again once
 * (1: NetEase added, 2: Kugou added, 3: Kugou finds songs however their titles are capitalised).
 */
const LYRICS_LOOKUP = 3;

const lyricsInFlight = new Map<number, Promise<MusicLyrics | null>>();

function fromCache(c: mdb.CachedLyrics): MusicLyrics | null {
  const source = c.provider === 'kugou' || c.provider === 'netease' ? c.provider : 'lrclib';
  if (c.synced) return { text: c.synced, synced: true, source, instrumental: c.instrumental };
  if (c.instrumental) return { text: '', synced: false, source, instrumental: true };
  if (c.plain) return { text: c.plain, synced: false, source };
  return null;
}

/**
 * Lyrics for a song: synced lyrics from the file (sidecar .lrc or embedded) first, then online
 * (Kugou, NetEase, then LRCLIB; when allowed in Settings, looked up once and cached), then the file's plain lyrics.
 */
export function lyricsFor(trackId: number, online = useLibraryStore.getState().settings.music_lyrics_online, refresh = false): Promise<MusicLyrics | null> {
  const running = lyricsInFlight.get(trackId);
  if (running && !refresh) return running;
  const job = (async (): Promise<MusicLyrics | null> => {
    const row = await mdb.musicTrackFile(trackId);
    if (!row) return null;
    const own: MusicLyrics | null = row.lyrics ? { text: row.lyrics, synced: looksSynced(row.lyrics), source: row.lyrics_source === 'sidecar' ? 'sidecar' : 'embedded' } : null;
    if (own?.synced) return own;
    const cached = await mdb.cachedLyrics(trackId);
    // `refresh` ("Search again") skips a remembered "not found".
    const missing = cached && !cached.synced && !cached.plain && !cached.instrumental;
    // Rows from an older lookup are looked up again once: the services asked now time more songs
    // word by word.
    const current = !!cached && (cached.lookup ?? 0) >= LYRICS_LOOKUP;
    if (cached && current && !(refresh && missing) && (!missing || Date.now() - cached.fetched_at < LYRICS_RETRY_MS)) {
      const hit = fromCache(cached);
      return hit?.synced ? hit : own ?? hit;
    }
    // An older answer stays in use until the new lookup succeeds (offline, or the lookup fails).
    const old = cached && !current ? fromCache(cached) : null;
    const fallback = old?.synced ? old : own ?? old;
    if (!online) return fallback;
    let found: OnlineLyrics | null;
    try {
      found = await invoke<OnlineLyrics | null>('music_lyrics_fetch', { artist: row.artist, title: row.title, album: row.album, duration: row.duration });
    } catch (e) {
      console.warn('[music] lyrics lookup failed', e);
      return fallback; // offline: try again next time
    }
    await mdb.saveLyricsCache(trackId, { ...(found ?? { synced: null, plain: null, instrumental: false, provider: 'none' }), lookup: LYRICS_LOOKUP });
    const hit = found ? fromCache({ ...found, fetched_at: Date.now(), lookup: LYRICS_LOOKUP }) : null;
    return hit?.synced ? hit : own ?? hit;
  })().finally(() => lyricsInFlight.delete(trackId));
  lyricsInFlight.set(trackId, job);
  return job;
}

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff', 'wavpack', 'ape']);
const CONVERTIBLE = new Set(['mp3', 'flac', 'aac', 'alac', 'vorbis', 'opus', 'wav', 'aiff', 'wavpack', 'ape', 'musepack', 'speex']);

/** Registers a song with the media server: the original file, or an AAC conversion when `codecs` can't play it. */
export async function registerMusicStream(trackId: number, codecs: string[]): Promise<{ token: string; transcoded: boolean } | null> {
  const row = await mdb.musicTrackFile(trackId);
  if (!row) return null;
  const codec = row.codec ?? '';
  const transcoded = !codecs.includes(codec) && (CONVERTIBLE.has(codec) || !codec || codec === 'unknown');
  // Lossless songs stay lossless for players that take ALAC (Safari); the rest get AAC.
  const lossless = transcoded && LOSSLESS.has(codec) && codecs.includes('alac');
  const token = await registerStream(row.file_path, { format: !transcoded ? 'direct' : lossless ? 'alac' : 'aac', width: 0, height: 0, tone_map: false, aid: null, sid: null, sub_style: [] });
  return { token, transcoded };
}

/** Keeps the few most recent music streams of one listener (current + preloaded next). */
export class StreamRing {
  private tokens: string[] = [];
  constructor(private keep = 3) {}
  /** Releases the oldest streams beyond `keep`, except any still in one of the player's `inUse` URLs
   * (skipping around while a song plays used to release the playing song's stream). */
  add(token: string, inUse: string[] = []) {
    this.tokens.push(token);
    const used = (t: string) => inUse.some((u) => typeof u === 'string' && u.includes(t));
    for (let i = 0; this.tokens.length > this.keep && i < this.tokens.length - 1; ) {
      if (used(this.tokens[i])) i++;
      else releaseStream(this.tokens.splice(i, 1)[0]);
    }
  }
  clear() {
    for (const t of this.tokens) releaseStream(t);
    this.tokens = [];
  }
}

const desktopStreams = new StreamRing();
let serverPort = 0;
let codecs: string[] | null = null;

async function desktopStream(trackId: number, keep: string[] = []): Promise<MusicStream> {
  const reg = await registerMusicStream(trackId, (codecs ??= playableCodecs()));
  if (!reg) throw new Error('This song is no longer in your library');
  desktopStreams.add(reg.token, keep);
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
    lyrics: (id, refresh) => lyricsFor(id, undefined, refresh),
    stream: (track, keep) => desktopStream(track.id, keep),
    played: async (id) => {
      await mdb.recordPlay(profileId(), id);
    },
    listened: async (id, seconds) => {
      await mdb.setPlaySeconds(profileId(), id, seconds);
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
    initMusicPlayer(api, { visualizer: true });
  } else {
    const dir = await invoke<string>('music_art_dir');
    initMusicPlayer(localApi(dir), { visualizer: true });
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
  /** Folders and files that couldn't be read this time. */
  unreadable?: string[];
}

const isUnder = (path: string, root: string) => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(`${r}/`);
};

/** Files to drop: gone from a reachable folder, or in a folder no longer in the list. */
/**
 * Songs to drop from the library: files no longer in a music folder, or not found in their folder.
 * Never songs in an offline folder or one that couldn't be read this time, and never when a folder
 * suddenly lost most of its songs (an empty mount point or a different disk on the same letter is
 * far likelier than a real clear-out): dropping a song also drops its playlists and favourites.
 */
export function goneMusicPaths(indexed: string[], seen: Set<string>, dirs: string[], offline: string[], unreadable: string[] = [], force = false): string[] {
  const missing = indexed.filter((p) => {
    if (!dirs.some((d) => isUnder(p, d))) return true;
    if (offline.some((d) => isUnder(p, d))) return false;
    if (unreadable.some((u) => p === u || isUnder(p, u))) return false;
    return !seen.has(p);
  });
  // Only a folder where every one of many songs vanished at once (and not on a full rescan).
  const suspicious = force
    ? []
    : dirs.filter((d) => {
        const had = indexed.filter((p) => isUnder(p, d)).length;
        const lost = missing.filter((p) => isUnder(p, d)).length;
        return had >= 20 && lost === had;
      });
  return missing.filter((p) => !suspicious.some((d) => isUnder(p, d)));
}

let scanning = false;
/** A scan asked for while one ran (a folder was just added, say): run once that one finishes. */
let queued: { force?: boolean; quiet?: boolean } | null = null;

/** Bumped when matching changes, so existing libraries are regrouped on the next scan. */
const MATCH_VERSION = 2;
const MATCH_KEY = 'tf-music-match';
const readMatchVersion = () => {
  try {
    return Number(localStorage.getItem(MATCH_KEY)) || 1;
  } catch {
    return MATCH_VERSION;
  }
};
const writeMatchVersion = () => {
  try {
    localStorage.setItem(MATCH_KEY, String(MATCH_VERSION));
  } catch {
    /* private storage: matched again next time, which is harmless */
  }
};

/** Whether a music scan is running (for Settings). */
export const useMusicScan = create<{ running: boolean }>(() => ({ running: false }));

/** Reads new and changed songs in the music folders; runs alongside the video scan. */
export async function runMusicScan(opts: { force?: boolean; quiet?: boolean } = {}) {
  if (scanning) {
    queued = { force: !!(queued?.force || opts.force), quiet: (queued?.quiet ?? true) && !!opts.quiet };
    return;
  }
  const { settings, toast } = useLibraryStore.getState();
  const dirs = settings.music_directories ?? [];
  scanning = true;
  useMusicScan.setState({ running: true });
  try {
    const index = await mdb.musicFileIndex();
    if (!dirs.length && !index.size) return;
    const reachable = dirs.length ? await invoke<boolean[]>('check_paths', { paths: dirs }) : [];
    const roots = dirs.filter((_, i) => reachable[i]);
    const offline = dirs.filter((_, i) => !reachable[i]);
    const known: Record<string, number> = {};
    for (const [path, rec] of index) known[path] = rec.mtime;
    // Songs imported before matching improved are matched again once, all together.
    const rematch = !!index.size && readMatchVersion() < MATCH_VERSION;
    const force = !!opts.force || rematch;
    const res = roots.length ? await invoke<MusicScanResult>('music_scan', { paths: roots, known, force }) : { seen: [], changed: [], unreadable: [] };
    // Songs moved or renamed since the last scan keep their row (and history) at the new path.
    const vanished = goneMusicPaths([...index.keys()], new Set(res.seen), dirs, offline, res.unreadable ?? [], !!opts.force);
    const moved = pairMoved(
      vanished.filter((p) => index.has(p)).map((p) => ({ path: p, size: index.get(p)!.size })),
      res.changed.filter((f) => !index.has(f.file_path)).map((f) => ({ path: f.file_path, size: f.file_size })),
    );
    if (moved.length) {
      await mdb.relinkMusicPaths(moved);
      for (const { from, to } of moved) {
        index.set(to, index.get(from)!);
        index.delete(from);
      }
    }
    const added = res.changed.filter((f) => !index.has(f.file_path)).length;
    await mdb.upsertMusicFiles(res.changed, Date.now(), dirs);
    if (roots.length && !offline.length) writeMatchVersion();
    const gone = goneMusicPaths([...index.keys()], new Set(res.seen), dirs, offline, res.unreadable ?? [], !!opts.force);
    await mdb.removeMusicPaths(gone);
    if (!gone.length && res.changed.length) await mdb.pruneMusic();
    if (res.changed.length || gone.length) await loadMusicLibrary(true);
    // The one-off rematch after an update isn't news: only new and removed songs are reported then.
    const updated = rematch && !opts.force ? 0 : res.changed.length - added;
    if (!opts.quiet && (added || gone.length || updated)) {
      toast(`Music: ${[`${added} song${added === 1 ? '' : 's'} added`, updated ? `${updated} updated` : '', gone.length ? `${gone.length} removed` : ''].filter(Boolean).join(' · ')}`, 'success');
    }
    if (offline.length && !opts.quiet) toast(`Offline music folder skipped: ${offline.join(', ')}`, 'error');
  } catch (e) {
    console.error('[music] scan failed', e);
    if (!opts.quiet) toast(`Music scan failed: ${String(e)}`, 'error');
  } finally {
    scanning = false;
    useMusicScan.setState({ running: false });
    const next = queued;
    queued = null;
    if (next) void runMusicScan(next);
  }
}
