import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { useLibraryStore } from '../store/useLibraryStore';
import { createPlaylist, setPlaylistTracks } from '../music/actions';
import { useMusicPlayer } from '../music/player';
import type { MusicTrack } from '../music/types';
import type { MusicQuality } from '../types/media';
import { catalog, chartCountry, sizedCover } from './musicCatalog';
import { connectSoulseek, downloadFolder, initMusicDownloads, useMusicDownloads, type AlbumJob, type SharedFile } from './musicDownloads';
import { runMusicScan, useMusicScan } from './music';
import * as mdb from './musicdb';

/**
 * Importing a playlist from a streaming service: its songs are read from the playlist's public
 * page (or a pasted list), each is matched to the store for its exact title, album, cover and
 * length, songs already in the library are skipped, and the rest are found one by one on Soulseek
 * and downloaded. What couldn't be found stays listed, to be found by hand. At the end the
 * playlist is made in the music library, in its original order.
 */

export type ImportSource = 'spotify' | 'apple' | 'youtube' | 'list';

/** A song as the playlist lists it. */
export interface PlaylistSong {
  title: string;
  artists: string[];
  album: string | null;
  lengthMs: number | null;
  appleId: string | null;
  cover: string | null;
  explicit: boolean;
}

export interface ReadPlaylist {
  source: ImportSource;
  id: string;
  name: string;
  owner: string | null;
  cover: string | null;
  /** How many songs the playlist has, when its page says (it may show fewer). */
  total: number | null;
  /** The page held only the first part of the playlist (Apple Music stops at 300 songs). */
  partial?: boolean;
  songs: PlaylistSong[];
}

/** The store's own details for a song: what it's tagged and searched with. */
export interface StoreSong {
  title: string;
  artist: string;
  album: string | null;
  albumArtist: string | null;
  track: number | null;
  disc: number | null;
  date: string | null;
  genre: string | null;
  cover: string | null;
  lengthMs: number | null;
}

export type SongState = 'waiting' | 'matching' | 'owned' | 'searching' | 'queued' | 'downloading' | 'checking' | 'done' | 'failed' | 'cancelled';

export interface ImportSong extends PlaylistSong {
  key: string;
  /** A music video's length includes its intro and outro: it isn't held against a file. */
  lengthTrusted: boolean;
  store: StoreSong | null;
  state: SongState;
  message: string;
  jobId: string | null;
  /** Bytes so far / total, while downloading. */
  progress: number;
  /** Where the file was filed. */
  path: string | null;
  /** The library song it is (when it was already there). */
  trackId: number | null;
  /** Who's sending it (while waiting or downloading). */
  from?: string | null;
  /** Searches so far: a song Soulseek didn't answer for is tried again later, once. */
  tries?: number;
  /** Not before this time (ms) when it's waiting to be tried again. */
  retryAt?: number;
}

export interface PlaylistImport {
  id: string;
  source: ImportSource;
  name: string;
  owner: string | null;
  cover: string | null;
  total: number | null;
  partial?: boolean;
  songs: ImportSong[];
  quality: MusicQuality;
  running: boolean;
  /** The playlist made in the music library. */
  playlistId: number | null;
  /** "Adding to your library…" while the final scan and playlist run. */
  finishing: boolean;
}

export const isSettled = (state: SongState) => ['owned', 'done', 'failed', 'cancelled'].includes(state);
export const isBusy = (state: SongState) => ['matching', 'searching', 'queued', 'downloading', 'checking'].includes(state);

interface ImportsState {
  imports: Record<string, PlaylistImport>;
  /** Newest first. */
  order: string[];
}

const SAVED = 'truongflix:playlist-imports';

/** Imports are kept between sessions (what was found, and what's left to find by hand). */
function loadSaved(): ImportsState {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as ImportsState | null;
    if (!saved?.order || !saved.imports) return { imports: {}, order: [] };
    // Nothing is in flight after a restart: those songs wait to be started again.
    for (const p of Object.values(saved.imports)) {
      p.running = false;
      p.finishing = false;
      p.songs = p.songs.map((s) => (isBusy(s.state) ? { ...s, state: 'waiting', jobId: null, progress: 0 } : s));
    }
    return { imports: saved.imports, order: saved.order.filter((id) => saved.imports[id]) };
  } catch {
    return { imports: {}, order: [] };
  }
}

export const usePlaylistImports = create<ImportsState>(() => (typeof localStorage === 'undefined' ? { imports: {}, order: [] } : loadSaved()));

let saving: ReturnType<typeof setTimeout> | null = null;
usePlaylistImports.subscribe((state) => {
  if (typeof localStorage === 'undefined') return;
  if (saving) clearTimeout(saving);
  saving = setTimeout(() => {
    const order = state.order.slice(0, 20);
    try {
      localStorage.setItem(SAVED, JSON.stringify({ order, imports: Object.fromEntries(order.map((id) => [id, state.imports[id]])) }));
    } catch {
      // Storage full: the imports still work for this session.
    }
  }, 800);
});

const API = 'https://itunes.apple.com';
/** Songs matched and searched for at once (the app also spaces Soulseek searches out: the
 *  server drops a connection that searches too fast). */
const SEARCHING = 2;
/** Songs in flight at once, downloads included (more only adds connections and splits the line). */
const ACTIVE = 12;
/** A song Soulseek didn't answer for waits this long before it's searched again. */
const RETRY_AFTER = 20_000;
/** A song whose copies were all busy or failing waits this long before it's tried again. */
const RETRY_BUSY_AFTER = 60_000;
/** After the connection drops, songs wait this long (while the app reconnects) before starting again. */
const RECONNECT_PAUSE = 5_000;

const notConnected = (message: string) => /not connected to soulseek|connection to soulseek|couldn.t reach soulseek|lost the connection/i.test(message);

export const SOURCE_NAMES: Record<ImportSource, string> = { spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube', list: 'Pasted list' };


// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Lowercase words without accents, brackets or punctuation. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** A title's own name: no "(feat. …)", "[From …]", " - 2014 Remaster". */
export function coreTitle(title: string) {
  const cut = title.search(/\s[-–—]\s|[([]|\s(?:feat|ft)\.?\s/i);
  const core = cut > 0 ? title.slice(0, cut) : title;
  return norm(core) || norm(title);
}

/** "KAROL G, Judeline & rusowsky" → each artist on their own. */
export const splitArtists = (credit: string) =>
  credit
    .split(/\s*(?:,|\s&\s|\s(?:feat|ft)\.?\s|\sx\s|\swith\s)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);

/** A song's artists for searching and checking: the store's credit first, each artist once. */
export function songArtists(song: Pick<ImportSong, 'artists' | 'store'>): string[] {
  const all = [...(song.store ? splitArtists(song.store.artist) : []), ...song.artists.flatMap(splitArtists)];
  const seen = new Set<string>();
  return all.filter((a) => {
    const k = norm(a);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Spotify song ids in pasted text (links copied out of the Spotify app: one per line). */
export function spotifySongIds(text: string): string[] {
  return [...text.matchAll(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/g)].map((m) => m[1]);
}

/** Reads songs from Spotify song links, 50 at a time; `onProgress` gets how many are read. */
async function readSpotifySongs(ids: string[], onProgress?: (done: number, total: number) => void): Promise<PlaylistSong[]> {
  const songs: PlaylistSong[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = await invoke<(Omit<PlaylistSong, 'album' | 'appleId' | 'cover'> & Partial<PlaylistSong> | null)[]>('music_spotify_songs', { ids: ids.slice(i, i + 50) });
    for (const s of batch) if (s) songs.push({ album: null, appleId: null, cover: null, ...s });
    onProgress?.(Math.min(ids.length, i + 50), ids.length);
  }
  return songs;
}

const looksLikeLink = (text: string) => /^https?:\/\//i.test(text.trim()) || /(spotify\.com|music\.apple\.com|youtube\.com|youtu\.be)\//i.test(text);

/** Reads a pasted playlist link, songs copied out of Spotify, or a pasted list of songs (`name`:
 *  the file it came from, used as the playlist's name when the list doesn't name it). */
export async function readPlaylist(input: string, onProgress?: (done: number, total: number) => void, name?: string): Promise<ReadPlaylist> {
  const text = input.trim();
  if (!text) throw new Error('Paste a playlist link or a list of songs.');
  const spotifyIds = spotifySongIds(text);
  if (spotifyIds.length && (spotifyIds.length > 1 || /\/track\/|spotify:track:/.test(text))) {
    const songs = await readSpotifySongs(spotifyIds, onProgress);
    if (!songs.length) throw new Error('Couldn’t read those Spotify songs. Check your connection and try again.');
    const missed = spotifyIds.length - songs.length;
    return { source: 'spotify', id: `spotify-songs-${Date.now()}`, name: 'Spotify songs', owner: missed ? `${missed} couldn’t be read` : null, cover: songs[0]?.cover ?? null, total: spotifyIds.length, songs };
  }
  if (looksLikeLink(text) && !text.includes('\n')) {
    const link = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    return invoke<ReadPlaylist>('music_playlist', { link });
  }
  const songs = parseSongList(text);
  if (!songs.length) throw new Error('No songs found. Put one song per line as “Artist - Title”, or paste an exported CSV.');
  return { source: 'list', id: `list-${Date.now()}`, name: listName(text) ?? name?.replace(/\.(csv|txt|tsv)$/i, '').trim() ?? 'Pasted songs', owner: null, cover: null, total: null, songs };
}

/** Splits a CSV line (quotes and doubled quotes understood). */
function csvCells(line: string, sep: string) {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

/** The playlist's name in an exported CSV (TuneMyMusic and Soundiiz add a "Playlist name" column). */
export function listName(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = [',', ';', '\t'].find((s) => lines[0]?.includes(s));
  if (!sep || lines.length < 2) return null;
  const header = csvCells(lines[0], sep).map((h) => h.toLowerCase());
  const at = header.findIndex((h) => /^playlist( name)?$/.test(h));
  return at >= 0 ? csvCells(lines[1], sep)[at]?.trim() || null : null;
}

const duration = (v: string | undefined, header: string): number | null => {
  if (!v) return null;
  if (/^\d+:\d{2}(:\d{2})?$/.test(v)) return v.split(':').reduce((n, p) => n * 60 + Number(p), 0) * 1000;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /ms/.test(header) || n > 20_000 ? Math.round(n) : Math.round(n * 1000);
};

/**
 * Songs from pasted text: an exported playlist CSV (Exportify, TuneMyMusic, Soundiiz and the like:
 * a header row naming the title and artist columns), or one song per line as "Artist - Title".
 */
export function parseSongList(text: string): PlaylistSong[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = [',', ';', '\t'].find((s) => lines[0].includes(s));
  if (sep) {
    const header = csvCells(lines[0], sep).map((h) => h.toLowerCase());
    const col = (...names: RegExp[]) => header.findIndex((h) => names.some((n) => n.test(h)));
    const title = col(/^track name$/, /^track$/, /^title$/, /^song( name)?$/, /^name$/);
    const artist = col(/^artist name\(s\)$/, /^artist names?$/, /^artists?$/);
    if (title >= 0 && artist >= 0) {
      const album = col(/^album name$/, /^album$/);
      const length = col(/duration/, /^length$/, /^time$/);
      return lines.slice(1).flatMap((line) => {
        const cells = csvCells(line, sep);
        const name = cells[title]?.trim();
        if (!name) return [];
        return [
          {
            title: name,
            artists: (cells[artist] ?? '').split(/\s*[,;]\s*/).filter(Boolean),
            album: cells[album]?.trim() || null,
            lengthMs: duration(cells[length], header[length] ?? ''),
            appleId: null,
            cover: null,
            explicit: false,
          },
        ];
      });
    }
  }
  return lines.flatMap((raw) => {
    const line = raw.replace(/^\s*\d+[.)]\s+/, '').trim();
    if (!line) return [];
    const parts = line.split(/\s+[-–—]\s+/);
    const [artist, title] = parts.length >= 2 ? [parts[0], parts.slice(1).join(' - ')] : ['', line];
    return [{ title: title.trim(), artists: artist ? artist.split(/\s*(?:,|&| x | feat\.? | ft\.? )\s*/i).filter(Boolean) : [], album: null, lengthMs: null, appleId: null, cover: null, explicit: false }];
  });
}

const VIDEO_JUNK =
  /\s*[([](?:official(?: music| lyric| audio| hd)? ?(?:video|audio|visuali[sz]er|music video)?|video oficial|v[ií]deo oficial|lyrics?(?: video)?|video lyric|audio(?: oficial)?|visuali[sz]er|performance video|music video|hd|4k|explicit|clean|mv|m\/v|letra|official)[^)\]]*[)\]]/gi;

/**
 * A music video's song: "Artist - Title (Official Video)" or "Title (Video Oficial) - Artist",
 * with the channel ("Artist - Topic", "ArtistVEVO") telling which side is the artist.
 */
export function songFromVideo(title: string, channel: string | null): { title: string; artists: string[] } {
  let text = title.replace(VIDEO_JUNK, '').replace(/\s+\|.*$/, '').trim();
  const featured: string[] = [];
  text = text.replace(/\s*[([]?\s*\b(?:ft|feat|featuring)\.?\s+([^)\]]+)[)\]]?/i, (_, who: string) => {
    featured.push(...who.split(/\s*(?:,|&| x )\s*/).filter(Boolean));
    return '';
  });
  const parts = text.split(/\s+[-–—]\s+/);
  const chan = norm(channel ?? '').replace(/ ?vevo$/, '').replace(/ /g, '');
  const squash = (s: string) => norm(s).replace(/ /g, '');
  let artist = '';
  let song = text;
  if (parts.length >= 2) {
    const [a, ...rest] = parts;
    const b = rest.join(' - ');
    // The side naming the channel is the artist; otherwise "Artist - Title" is the usual order.
    if (chan && squash(b).includes(chan) && !squash(a).includes(chan)) [artist, song] = [b, a];
    else [artist, song] = [a, b];
  } else if (channel) {
    artist = channel;
  }
  const artists = [...artist.split(/\s*(?:,|&| x )\s*/).filter(Boolean), ...featured];
  return { title: song.replace(VIDEO_JUNK, '').trim() || title, artists: artists.length ? artists : channel ? [channel] : [] };
}

// ---------------------------------------------------------------------------
// The store's details
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A song from an iTunes search or lookup row. */
export function storeSongFrom(r: Json): StoreSong | null {
  const title = str(r.trackName);
  const artist = str(r.artistName);
  if (!title || !artist || (r.kind != null && r.kind !== 'song')) return null;
  const album = str(r.collectionName)?.replace(/\s+-\s+(Single|EP)$/i, '') ?? null;
  return {
    title,
    artist,
    album,
    albumArtist: str(r.collectionArtistName) ?? artist,
    track: num(r.trackNumber),
    disc: num(r.discNumber),
    date: str(r.releaseDate)?.slice(0, 10) ?? null,
    genre: str(r.primaryGenreName),
    cover: sizedCover(str(r.artworkUrl100), 600),
    lengthMs: num(r.trackTimeMillis),
  };
}

const sameArtist = (a: string, b: string) => {
  const x = norm(a).replace(/^the /, '');
  const y = norm(b).replace(/^the /, '');
  return !!x && !!y && (x === y || ` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `));
};

/** The store song a playlist song is, from search results: same title, an artist in common, same length. */
export function pickStoreSong(song: Pick<ImportSong, 'title' | 'artists' | 'lengthMs' | 'lengthTrusted' | 'explicit'>, rows: Json[]): StoreSong | null {
  const want = coreTitle(song.title);
  let best: { score: number; found: StoreSong } | null = null;
  for (const r of rows) {
    const found = storeSongFrom(r);
    if (!found) continue;
    const have = coreTitle(found.title);
    if (have !== want && !(want.length > 6 && (have.startsWith(want) || want.startsWith(have)))) continue;
    const artistHit = !song.artists.length || song.artists.some((a) => sameArtist(a, found.artist));
    if (!artistHit && song.lengthTrusted) continue;
    let score = have === want ? 10 : 5;
    if (artistHit) score += 10;
    if (song.lengthMs && found.lengthMs) {
      const gap = Math.abs(song.lengthMs - found.lengthMs) / 1000;
      if (gap > (song.lengthTrusted ? 5 : 45)) continue;
      score += gap <= 2 ? 6 : gap <= 5 ? 3 : 0;
    } else if (!artistHit) continue;
    if (/karaoke|tribute|made famous|in the style of/i.test(`${found.artist} ${found.album ?? ''}`)) score -= 20;
    // A video album's copy of a song is filed better under the album itself.
    if (isVideoAlbum(found.album)) score -= 3;
    if (song.explicit === (r.trackExplicitness === 'explicit')) score += 1;
    if (!best || score > best.score) best = { score, found };
  }
  return best && best.score > 0 ? best.found : null;
}

export const isVideoAlbum = (album: string | null) => !!album && /\bvideo album\b|\(video\)$/i.test(album);

/** The store's songs for Apple Music store ids, 50 at a time. */
async function lookupApple(ids: string[]): Promise<Map<string, StoreSong>> {
  const out = new Map<string, StoreSong>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const data = await catalog<Json>(`${API}/lookup?id=${batch.join(',')}&country=${chartCountry()}`, true);
      for (const r of (Array.isArray(data?.results) ? data.results : []) as Json[]) {
        const found = storeSongFrom(r);
        const id = num(r.trackId);
        if (found && id != null) out.set(String(id), found);
      }
    } catch {
      // Songs that weren't looked up are matched by search instead.
    }
  }
  return out;
}

async function searchStore(song: ImportSong): Promise<StoreSong | null> {
  const term = encodeURIComponent(`${song.artists[0] ?? ''} ${song.title.replace(/[([].*?[)\]]/g, ' ')}`.replace(/\s+/g, ' ').trim());
  try {
    const data = await catalog<Json>(`${API}/search?term=${term}&media=music&entity=song&limit=15&country=${chartCountry()}`, true);
    return pickStoreSong(song, (Array.isArray(data?.results) ? data.results : []) as Json[]);
  } catch {
    return null;
  }
}

/** The library song this is, when it's already there. */
export function inLibrary(song: Pick<ImportSong, 'title' | 'artists'>, store: StoreSong | null, tracks: MusicTrack[]): MusicTrack | null {
  const titles = new Set([coreTitle(song.title), store ? coreTitle(store.title) : ''].filter(Boolean));
  const artists = [...song.artists, ...(store ? [store.artist] : [])];
  return tracks.find((t) => titles.has(coreTitle(t.title)) && (!artists.length || artists.some((a) => sameArtist(a, t.artist) || sameArtist(a, t.albumArtist)))) ?? null;
}

// ---------------------------------------------------------------------------
// Running an import
// ---------------------------------------------------------------------------

function patchImport(id: string, change: (p: PlaylistImport) => Partial<PlaylistImport>) {
  usePlaylistImports.setState((s) => {
    const p = s.imports[id];
    return p ? { imports: { ...s.imports, [id]: { ...p, ...change(p) } } } : s;
  });
}

function patchSong(id: string, key: string, change: Partial<ImportSong>) {
  patchImport(id, (p) => ({ songs: p.songs.map((s) => (s.key === key ? { ...s, ...change } : s)) }));
}

const getImport = (id: string) => usePlaylistImports.getState().imports[id];

/** Adds a read playlist as an import (not started yet); returns its id. */
export function addImport(read: ReadPlaylist, quality: MusicQuality): string {
  const id = crypto.randomUUID();
  const songs: ImportSong[] = read.songs.map((s, i) => {
    const video = read.source === 'youtube' ? songFromVideo(s.title, s.artists[0] ?? null) : null;
    return {
      ...s,
      ...(video ?? {}),
      key: String(i),
      lengthTrusted: read.source !== 'youtube',
      store: null,
      state: 'waiting',
      message: '',
      jobId: null,
      progress: 0,
      path: null,
      trackId: null,
    };
  });
  usePlaylistImports.setState((st) => ({
    imports: { ...st.imports, [id]: { id, source: read.source, name: read.name, owner: read.owner, cover: read.cover, total: read.total, partial: read.partial, songs, quality, running: false, playlistId: null, finishing: false } },
    order: [id, ...st.order],
  }));
  return id;
}

export function removeImport(id: string) {
  stopImport(id);
  usePlaylistImports.setState((s) => {
    const imports = { ...s.imports };
    delete imports[id];
    return { imports, order: s.order.filter((o) => o !== id) };
  });
}

export const setImportQuality = (id: string, quality: MusicQuality) => patchImport(id, () => ({ quality }));

let following = false;

/** Keeps songs' states in step with their Soulseek jobs. */
function follow() {
  if (following) return;
  following = true;
  useMusicDownloads.subscribe((s, before) => {
    if (s.jobs === before.jobs) return;
    for (const job of Object.values(s.jobs)) {
      if (job.kind !== 'song' || !job.group || before.jobs[job.id] === job) continue;
      const p = getImport(job.group);
      const song = p?.songs.find((x) => x.jobId === job.id);
      if (!p || !song) continue;
      const dropped = job.state === 'failed' && job.code === 'connection' && p.running;
      const retry = job.state === 'failed' && (job.code === 'no-answer' || job.code === 'not-shared' || job.code === 'download') && (song.tries ?? 0) < 2 && p.running;
      if (dropped) {
        // The connection dropped mid-song: it starts again once Soulseek is back, as if new.
        patchSong(p.id, song.key, { state: 'waiting', message: '', jobId: null, from: null, progress: 0, tries: Math.max(0, (song.tries ?? 1) - 1), retryAt: Date.now() + RECONNECT_PAUSE });
      } else {
        // Soulseek drops searches when it's busy, and people's queues clear: such a song waits a
        // little (a minute when copies were found but all busy) and is tried again.
        const wait = job.code === 'download' ? RETRY_BUSY_AFTER : RETRY_AFTER;
        patchSong(p.id, song.key, retry ? { state: 'waiting', message: job.message, jobId: null, from: null, retryAt: Date.now() + wait } : songFromJob(job));
      }
      if (['done', 'failed', 'cancelled'].includes(job.state)) void pump(p.id);
    }
  });
}

function songFromJob(job: AlbumJob): Partial<ImportSong> {
  const state = job.state as SongState;
  return {
    state,
    message: job.message,
    progress: job.total > 0 ? Math.min(1, job.bytes / job.total) : 0,
    path: job.path,
    from: job.source?.user ?? null,
  };
}

/** Starts (or resumes) downloading an import's songs. */
export async function startImport(id: string) {
  if (!downloadFolder()) throw new Error('Add a music folder in Settings → Music first.');
  await initMusicDownloads();
  await connectSoulseek();
  follow();
  const p = getImport(id);
  if (!p) return;
  // Failed and cancelled songs are tried again.
  patchImport(id, (x) => ({ running: true, songs: x.songs.map((s) => (s.state === 'failed' || s.state === 'cancelled' ? { ...s, state: 'waiting', message: '', tries: 0, retryAt: undefined } : s)) }));
  // Apple Music songs are looked up together, by their store ids.
  const ids = p.songs.filter((s) => s.appleId && !s.store).map((s) => s.appleId!);
  if (ids.length) {
    const found = await lookupApple(ids);
    patchImport(id, (x) => ({ songs: x.songs.map((s) => (s.appleId && found.has(s.appleId) ? { ...s, store: found.get(s.appleId)! } : s)) }));
  }
  void pump(id);
}

/** Stops starting songs and cancels the ones in flight. */
export function stopImport(id: string) {
  const p = getImport(id);
  if (!p) return;
  clearTimeout(wakeups.get(id));
  wakeups.delete(id);
  patchImport(id, () => ({ running: false }));
  for (const s of p.songs) {
    if (s.jobId && isBusy(s.state)) void invoke('slsk_cancel', { id: s.jobId }).catch(() => {});
    if (s.state === 'matching') patchSong(id, s.key, { state: 'waiting' });
  }
}

const wakeups = new Map<string, ReturnType<typeof setTimeout>>();

/** Starts the next songs while there's room; finishes the import when every song is settled. */
async function pump(id: string) {
  const p = getImport(id);
  if (!p) return;
  if (!p.running) {
    if (!p.songs.some((s) => isBusy(s.state))) void finish(id);
    return;
  }
  // While Soulseek reconnects, nothing new starts; the import picks up once it's back.
  const status = useMusicDownloads.getState().status.state;
  if (status !== 'online') {
    if (!wakeups.has(id)) {
      wakeups.set(
        id,
        setTimeout(() => {
          wakeups.delete(id);
          void (status === 'connecting' ? Promise.resolve() : connectSoulseek().catch(() => {})).then(() => pump(id));
        }, 3000),
      );
    }
    return;
  }
  const busy = p.songs.filter((s) => isBusy(s.state)).length;
  const searching = p.songs.filter((s) => s.state === 'matching' || s.state === 'searching').length;
  const room = Math.min(ACTIVE - busy, SEARCHING - searching);
  const now = Date.now();
  const waiting = p.songs.filter((s) => s.state === 'waiting');
  const next = waiting.filter((s) => !s.retryAt || s.retryAt <= now).slice(0, Math.max(0, room));
  const later = waiting.filter((s) => s.retryAt && s.retryAt > now);
  if (later.length && !wakeups.has(id)) {
    // Songs waiting to be searched again start once their wait is over.
    const at = Math.min(...later.map((s) => s.retryAt!));
    wakeups.set(
      id,
      setTimeout(() => {
        wakeups.delete(id);
        void pump(id);
      }, at - now + 50),
    );
  }
  if (!next.length) {
    if (!busy && !later.length) {
      patchImport(id, () => ({ running: false }));
      void finish(id);
    }
    return;
  }
  for (const song of next) void startSong(id, song.key);
}

async function startSong(id: string, key: string, copy?: { user: string } & SharedFile) {
  const before = getImport(id)!.songs.find((s) => s.key === key)!;
  patchSong(id, key, { state: 'matching', message: '', retryAt: undefined, tries: copy ? before.tries : (before.tries ?? 0) + 1 });
  try {
    let song = getImport(id)!.songs.find((s) => s.key === key)!;
    if ((!song.store || isVideoAlbum(song.store.album)) && !copy) {
      const store = (await searchStore(song)) ?? song.store;
      if (store) patchSong(id, key, { store });
      song = { ...song, store };
    }
    const owned = copy ? null : inLibrary(song, song.store, useMusicPlayer.getState().library?.tracks ?? []);
    if (owned) {
      patchSong(id, key, { state: 'owned', trackId: owned.id, message: '' });
      return;
    }
    const p = getImport(id)!;
    const job = await downloadSong(id, p.source, song, p.quality, copy);
    patchSong(id, key, { jobId: job.id, ...songFromJob(job) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (notConnected(message) && !copy && getImport(id)?.running) {
      // Not this song's fault: it waits for Soulseek to be back.
      patchSong(id, key, { state: 'waiting', message: '', tries: before.tries, retryAt: Date.now() + RECONNECT_PAUSE });
    } else {
      patchSong(id, key, { state: 'failed', message });
    }
  } finally {
    void pump(id);
  }
}

/** Downloads one song (from `copy` when the user picked a file). */
async function downloadSong(group: string, source: ImportSource, song: ImportSong, quality: MusicQuality, copy?: { user: string } & SharedFile): Promise<AlbumJob> {
  const destination = downloadFolder();
  if (!destination) throw new Error('Add a music folder in Settings → Music first.');
  const store = song.store;
  // A video's thumbnail isn't a cover.
  const cover = store?.cover ?? (source === 'youtube' ? null : song.cover);
  const coverPath = cover ? await invoke<string>('live_artwork', { url: cover }).catch(() => null) : null;
  const artists = songArtists(song);
  return invoke<AlbumJob>('slsk_download_song', {
    request: {
      id: crypto.randomUUID(),
      group,
      title: store?.title ?? song.title,
      artists: artists.length ? artists : [],
      album: store?.album ?? song.album,
      lengthMs: store?.lengthMs ?? (song.lengthTrusted ? song.lengthMs : null),
      artist: store?.artist ?? song.artists.join(', '),
      albumArtist: store?.albumArtist ?? null,
      track: store?.album ? store.track : null,
      disc: store?.album ? store.disc : null,
      date: store?.date ?? null,
      genre: store?.genre ?? null,
      quality: copy ? 'any' : quality,
      destination,
      coverPath,
      coverUrl: cover,
      copy: copy ?? null,
    },
  });
}

/** Tries a song again (searching for it anew). */
export function retrySong(id: string, key: string) {
  patchSong(id, key, { state: 'waiting', message: '', jobId: null, tries: 0, retryAt: undefined });
  const p = getImport(id);
  if (p && !p.running) void startImport(id).catch((e) => patchSong(id, key, { state: 'failed', message: String(e) }));
  else void pump(id);
}

/** Downloads a file the user picked for a song. */
export async function pickSongFile(id: string, key: string, file: { user: string } & SharedFile) {
  await initMusicDownloads();
  await connectSoulseek();
  follow();
  await startSong(id, key, file);
}

const pathKey = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Scans the new songs in and makes (or updates) the playlist in the music library. */
async function finish(id: string) {
  const p = getImport(id);
  if (!p || p.finishing || !p.songs.some((s) => s.state === 'done' || s.state === 'owned')) return;
  patchImport(id, () => ({ finishing: true }));
  try {
    const wanted = () => getImport(id)!.songs.filter((s) => s.state === 'done' && s.path).map((s) => pathKey(s.path!));
    let index = new Map<string, number>();
    for (let attempt = 0; attempt < 2; attempt++) {
      await runMusicScan({ quiet: true });
      while (useMusicScan.getState().running) await new Promise((r) => setTimeout(r, 400));
      index = new Map([...(await mdb.musicFileIndex())].map(([path, rec]) => [pathKey(path), rec.id]));
      if (wanted().every((w) => index.has(w))) break;
    }
    const now = getImport(id)!;
    const ids = now.songs.flatMap((s) => (s.state === 'owned' && s.trackId != null ? [s.trackId] : s.state === 'done' && s.path && index.has(pathKey(s.path)) ? [index.get(pathKey(s.path))!] : []));
    if (!ids.length || !useMusicPlayer.getState().api) return;
    const playlists = useMusicPlayer.getState().library?.playlists ?? [];
    // Importing the same playlist again (say its full CSV after the first 300 songs from Apple's
    // page) updates the playlist an earlier import of it made, rather than adding a second.
    const earlier = Object.values(usePlaylistImports.getState().imports).find((p) => p.id !== id && p.name === now.name && p.playlistId != null && playlists.some((x) => x.id === p.playlistId))?.playlistId;
    const target = now.playlistId != null && playlists.some((x) => x.id === now.playlistId) ? now.playlistId : (earlier ?? null);
    if (target != null) {
      await setPlaylistTracks(target, ids);
      patchImport(id, () => ({ playlistId: target }));
    } else {
      const made = await createPlaylist(now.name, ids);
      patchImport(id, () => ({ playlistId: made?.id ?? null }));
    }
    const missing = now.songs.filter((s) => s.state === 'failed' || s.state === 'cancelled').length;
    useLibraryStore.getState().toast(`${now.name} is in your music library${missing ? ` (${missing} song${missing === 1 ? '' : 's'} not found)` : ''}`, 'success');
  } catch (e) {
    useLibraryStore.getState().toast(`Couldn’t make the playlist: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    patchImport(id, () => ({ finishing: false }));
  }
}

/** Counts for an import's header. */
export function importCounts(p: PlaylistImport) {
  const c = { total: p.songs.length, done: 0, owned: 0, failed: 0, busy: 0, waiting: 0 };
  for (const s of p.songs) {
    if (s.state === 'done') c.done++;
    else if (s.state === 'owned') c.owned++;
    else if (s.state === 'failed' || s.state === 'cancelled') c.failed++;
    else if (s.state === 'waiting') c.waiting++;
    else c.busy++;
  }
  return c;
}
