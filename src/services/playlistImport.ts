import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { useLibraryStore } from '../store/useLibraryStore';
import { createPlaylist, importPlaylistCover, setPlaylistTracks } from '../music/actions';
import { useMusicPlayer } from '../music/player';
import type { MusicTrack } from '../music/types';
import type { MusicQuality } from '../types/media';
import { catalog, chartCountry, sizedCover } from './musicCatalog';
import { connectSoulseek, disconnectedByUser, downloadFolder, initMusicDownloads, loginRefused, useMusicDownloads, type AlbumJob, type SharedFile } from './musicDownloads';
import { runMusicScan, useMusicScan } from './music';
import * as mdb from './musicdb';

/**
 * Importing a playlist from a streaming service: its songs are read from the playlist's public
 * page (or a pasted list), each is matched to the store for its exact title, album, cover and
 * length, songs already in the library are skipped, and the rest are found on Soulseek and
 * downloaded: several songs of one album together (one search for the album, one person's folder),
 * the others one by one. What couldn't be found stays listed, to be found by hand. At the end the
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
  /** Why it failed, when it did ("quality": copies, but none in the quality asked for). */
  code?: string | null;
  /** The album download it's part of, while it's fetched with other songs of its album. */
  batch?: string | null;
  /** Searched for on its own, not with its album (the album's copies didn't give it). */
  solo?: boolean;
}

export interface PlaylistImport {
  id: string;
  source: ImportSource;
  /** The streaming service's id for the playlist (made up for pasted lists). */
  sourceId?: string;
  name: string;
  owner: string | null;
  cover: string | null;
  total: number | null;
  partial?: boolean;
  songs: ImportSong[];
  /** The quality picked for this import; it's only used when `qualityOwn` (see `importQuality`). */
  quality: MusicQuality;
  /** The user picked a quality for this import itself; otherwise it follows Settings. */
  qualityOwn?: boolean;
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
  let saved: Partial<ImportsState> | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as Partial<ImportsState> | null;
  } catch {
    return { imports: {}, order: [] };
  }
  const imports: Record<string, PlaylistImport> = {};
  const order: string[] = [];
  for (const id of Array.isArray(saved?.order) ? saved.order : []) {
    const p = saved?.imports?.[id];
    // A damaged import is left out; the others still load.
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !Array.isArray(p.songs) || imports[id]) continue;
    const songs = p.songs.filter((s) => s && typeof s === 'object' && typeof s.key === 'string' && typeof s.title === 'string' && Array.isArray(s.artists));
    // Nothing is in flight after a restart: those songs wait to be started again.
    imports[id] = { ...p, running: false, finishing: false, songs: songs.map((s) => (isBusy(s.state) ? { ...s, state: 'waiting', jobId: null, progress: 0, batch: null } : s)) };
    order.push(id);
  }
  return { imports, order };
}

export const usePlaylistImports = create<ImportsState>(() => (typeof localStorage === 'undefined' ? { imports: {}, order: [] } : loadSaved()));

/** Saved at most this often while an import runs (its songs change many times a second). */
const SAVE_EVERY = 3000;
/** Most characters of saved imports (the newest always fits): the same storage holds the app's other settings. */
const SAVE_BUDGET = 1_500_000;
let saving: ReturnType<typeof setTimeout> | null = null;

function saveImports() {
  saving = null;
  const state = usePlaylistImports.getState();
  const order: string[] = [];
  const parts: string[] = [];
  let size = 0;
  for (const id of state.order.slice(0, 20)) {
    const p = state.imports[id];
    if (!p) continue;
    const json = JSON.stringify(p);
    if (order.length && size + json.length > SAVE_BUDGET) break;
    order.push(id);
    parts.push(`${JSON.stringify(id)}:${json}`);
    size += json.length;
  }
  try {
    localStorage.setItem(SAVED, `{"order":${JSON.stringify(order)},"imports":{${parts.join(',')}}}`);
  } catch {
    // Storage full: the imports still work for this session.
  }
}

/** Saves now anything not yet saved (when the app closes). */
export function flushImports() {
  if (!saving) return;
  clearTimeout(saving);
  saveImports();
}

if (typeof localStorage !== 'undefined') {
  usePlaylistImports.subscribe(() => {
    saving ??= setTimeout(saveImports, SAVE_EVERY);
  });
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushImports);
}

const API = 'https://itunes.apple.com';
/** Songs matched and searched for at once. The app spaces Soulseek searches out itself (at most
 *  10 a minute), so this only keeps that allowance used: with 2, a big import used about 8. */
const SEARCHING = 3;
/** Songs in flight at once, downloads included (more only adds connections and splits the line). */
const ACTIVE = 12;
/** A song Soulseek didn't answer for waits this long before it's searched again. */
const RETRY_AFTER = 20_000;
/** A song whose copies were all busy or failing waits this long before it's tried again. */
const RETRY_BUSY_AFTER = 60_000;
/** After the connection drops, songs wait this long (while the app reconnects) before starting again. */
const RECONNECT_PAUSE = 5_000;
/** Songs of one album waiting together are fetched together (one search for the album, one
 *  person's folder) once there are this many: Soulseek allows only so many searches a minute,
 *  and one person's queue for several songs beats a queue with each of several people. */
export const ALBUM_GROUP_MIN = 2;
/** Most songs fetched together in one album download. */
const ALBUM_GROUP_MAX = 50;

const notConnected = (message: string) => /not connected to soulseek|connection to soulseek|couldn.t reach soulseek|lost the connection|pausing this account/i.test(message);

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
    // A long playlist is read by scrolling its page, which reports how far it has got.
    const stop = onProgress ? await listen<number>('playlist-read-progress', ({ payload }) => onProgress(payload, 0)) : null;
    try {
      return await invoke<ReadPlaylist>('music_playlist', { link });
    } finally {
      stop?.();
    }
  }
  const songs = parseSongList(text);
  if (!songs.length) throw new Error('No songs found. Put one song per line as “Artist - Title”, or paste an exported CSV.');
  return { source: 'list', id: `list-${Date.now()}`, name: listName(text) ?? name?.replace(/\.(csv|txt|tsv)$/i, '').trim() ?? 'Pasted songs', owner: null, cover: null, total: null, songs };
}

/** Line breaks of any kind (old Mac exports end lines with a bare carriage return). */
const LINE_BREAK = /\r\n|\r|\n/;

/** The separator of a CSV text, from its first line (none when it isn't one). */
const csvSeparator = (text: string) => {
  const first = text.trim().split(LINE_BREAK)[0] ?? '';
  return [',', ';', '\t'].find((s) => first.includes(s));
};

/** A CSV text's rows (quoted cells may hold the separator, doubled quotes and line breaks). */
function csvRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = () => {
    row.push(cell.replace(/\s+/g, ' ').trim());
    cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) endCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endCell();
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += c;
  }
  endCell();
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

/** The playlist's name in an exported CSV (TuneMyMusic and Soundiiz add a "Playlist name" column). */
export function listName(text: string): string | null {
  const sep = csvSeparator(text);
  if (!sep) return null;
  const rows = csvRows(text, sep);
  if (rows.length < 2) return null;
  const at = rows[0].findIndex((h) => /^playlist( name)?$/.test(h.toLowerCase()));
  return at >= 0 ? rows[1][at]?.trim() || null : null;
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
  const lines = text.split(LINE_BREAK).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = csvSeparator(text);
  const rows = sep ? csvRows(text, sep) : [];
  if (sep && rows.length) {
    const header = rows[0].map((h) => h.toLowerCase());
    const col = (...names: RegExp[]) => header.findIndex((h) => names.some((n) => n.test(h)));
    const title = col(/^track name$/, /^track$/, /^title$/, /^song( name)?$/, /^name$/);
    const artist = col(/^artist name\(s\)$/, /^artist names?$/, /^artists?$/);
    if (title >= 0 && artist >= 0) {
      const album = col(/^album name$/, /^album$/);
      const length = col(/duration/, /^length$/, /^time$/);
      return rows.slice(1).flatMap((cells) => {
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
  // "ft. X" runs to its closing bracket, the " - " before the title, or the end.
  text = text.replace(/\s*[([]?\s*\b(?:ft|feat|featuring)\.?\s+([^)\]]+?)(?=[)\]]|\s+[-–—]\s+|$)[)\]]?/i, (_, who: string) => {
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

/** The library's songs by title, worked out once per library (not once per imported song). */
const byTitle = new WeakMap<MusicTrack[], Map<string, MusicTrack[]>>();
function tracksTitled(tracks: MusicTrack[]) {
  let index = byTitle.get(tracks);
  if (!index) {
    index = new Map();
    for (const t of tracks) {
      const key = coreTitle(t.title);
      const list = index.get(key);
      if (list) list.push(t);
      else index.set(key, [t]);
    }
    byTitle.set(tracks, index);
  }
  return index;
}

/** The library song this is, when it's already there. */
export function inLibrary(song: Pick<ImportSong, 'title' | 'artists'>, store: StoreSong | null, tracks: MusicTrack[]): MusicTrack | null {
  const titles = new Set([coreTitle(song.title), store ? coreTitle(store.title) : ''].filter(Boolean));
  const artists = [...song.artists, ...(store ? [store.artist] : [])];
  const index = tracksTitled(tracks);
  for (const title of titles) {
    const found = index.get(title)?.find((t) => !artists.length || artists.some((a) => sameArtist(a, t.artist) || sameArtist(a, t.albumArtist)));
    if (found) return found;
  }
  return null;
}

/** The same song twice in one playlist (by its store details when it has them). */
const songIdentity = (s: Pick<ImportSong, 'title' | 'artists' | 'store'>) => `${coreTitle(s.store?.title ?? s.title)}\n${norm(s.store?.artist ?? s.artists[0] ?? '')}`;

/** The album a song is fetched with, and who it's by, as the store (else the playlist) names
 *  them. None for a song with no album, or a video album's. */
export function albumOf(song: Pick<ImportSong, 'album' | 'artists' | 'store'>): { album: string; artist: string } | null {
  const album = (song.store ? song.store.album : song.album)?.trim();
  const artist = (song.store ? (song.store.albumArtist ?? song.store.artist) : song.artists[0])?.trim();
  return album && artist && !isVideoAlbum(album) ? { album, artist } : null;
}

/** Songs are of the same album when its name and its main artist read the same. */
export function albumKey(song: Pick<ImportSong, 'album' | 'artists' | 'store'>): string | null {
  const of = albumOf(song);
  if (!of) return null;
  const album = norm(of.album);
  const artist = norm(splitArtists(of.artist)[0] ?? of.artist).replace(/^the /, '');
  return album && artist ? `${album}\n${artist}` : null;
}

/**
 * The songs to start, in playlist order, as units: songs of one album (at least `min` of them,
 * none to be searched for on its own) go together, each other song on its own.
 */
export function albumGroups<S extends Pick<ImportSong, 'key' | 'album' | 'artists' | 'store' | 'solo'>>(songs: S[], min = ALBUM_GROUP_MIN): S[][] {
  const byAlbum = new Map<string, S[]>();
  for (const s of songs) {
    const key = s.solo ? null : albumKey(s);
    if (key) byAlbum.set(key, [...(byAlbum.get(key) ?? []), s]);
  }
  const units: S[][] = [];
  const placed = new Set<string>();
  for (const s of songs) {
    if (placed.has(s.key)) continue;
    const key = s.solo ? null : albumKey(s);
    const rest = key ? byAlbum.get(key)!.filter((u) => !placed.has(u.key)) : [];
    const unit = rest.length >= min ? rest.slice(0, ALBUM_GROUP_MAX) : [s];
    for (const u of unit) placed.add(u.key);
    units.push(unit);
  }
  return units;
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
    imports: { ...st.imports, [id]: { id, source: read.source, sourceId: read.id, name: read.name, owner: read.owner, cover: read.cover, total: read.total, partial: read.partial, songs, quality, running: false, playlistId: null, finishing: false } },
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

/** The quality an import downloads in: its own when the user picked one for it, else Settings'. */
export const importQuality = (p: Pick<PlaylistImport, 'quality' | 'qualityOwn'>): MusicQuality =>
  p.qualityOwn ? p.quality : useLibraryStore.getState().settings.soulseek_quality;

/** The quality a song failed for, when it failed only because no copy was in that quality. */
function failedQuality(song: ImportSong): MusicQuality | null {
  if (song.state !== 'failed' || !(song.code === 'quality' || /^There are copies of this song, but none in /.test(song.message))) return null;
  return /MP3/.test(song.message) ? 'mp3' : 'lossless';
}

/** Songs that failed only for want of a copy in another quality than the import's now are tried
 *  again (right away when the import is running). */
function retryOtherQuality(id: string) {
  const p = getImport(id);
  if (!p) return;
  const quality = importQuality(p);
  const again = (song: ImportSong) => {
    const was = failedQuality(song);
    return was !== null && was !== quality;
  };
  if (!p.songs.some(again)) return;
  patchImport(id, (x) => ({ songs: x.songs.map((song) => (again(song) ? { ...song, state: 'waiting' as const, message: '', code: null, jobId: null, tries: 0, retryAt: undefined } : song)) }));
  if (p.running) void pump(id);
}

/** Picks a quality for one import (it then no longer follows Settings). */
export function setImportQuality(id: string, quality: MusicQuality) {
  if (!getImport(id)) return;
  patchImport(id, () => ({ quality, qualityOwn: true }));
  retryOtherQuality(id);
}

// Imports follow the quality in Settings unless given their own: changing it there tries their
// wrong-quality songs again.
useLibraryStore.subscribe((s, before) => {
  if (s.settings.soulseek_quality === before.settings.soulseek_quality) return;
  for (const p of Object.values(usePlaylistImports.getState().imports)) if (!p.qualityOwn) retryOtherQuality(p.id);
});

let following = false;

/** Keeps songs' states in step with their Soulseek jobs. */
function follow() {
  if (following) return;
  following = true;
  useMusicDownloads.subscribe((s, before) => {
    // Soulseek is back: imports waiting for it carry on now, not at their next check.
    if (s.status.state === 'online' && before.status.state !== 'online') {
      for (const p of Object.values(usePlaylistImports.getState().imports)) {
        if (!p.running) continue;
        clearTimeout(wakeups.get(p.id));
        wakeups.delete(p.id);
        wakeAt.delete(p.id);
        void pump(p.id);
      }
    }
    if (s.jobs === before.jobs) return;
    for (const job of Object.values(s.jobs)) {
      if (job.kind !== 'song' || !job.group || before.jobs[job.id] === job) continue;
      const p = getImport(job.group);
      const song = p?.songs.find((x) => x.jobId === job.id);
      if (!p || !song) continue;
      const dropped = job.state === 'failed' && job.code === 'connection' && p.running;
      const retry = job.state === 'failed' && (job.code === 'no-answer' || job.code === 'not-shared' || job.code === 'download') && (song.tries ?? 0) < 2 && p.running;
      if (job.state === 'failed' && job.code === 'alone') {
        // Its album's copies didn't give it: it's searched for on its own, as soon as there's room.
        patchSong(p.id, song.key, { state: 'waiting', message: '', jobId: null, from: null, progress: 0, batch: null, solo: true, retryAt: undefined });
      } else if (dropped) {
        // The connection dropped mid-song: it starts again once Soulseek is back, as if new.
        patchSong(p.id, song.key, { state: 'waiting', message: '', jobId: null, from: null, progress: 0, batch: null, tries: Math.max(0, (song.tries ?? 1) - 1), retryAt: Date.now() + RECONNECT_PAUSE });
      } else if (retry) {
        // Soulseek drops searches when it's busy, and people's queues clear: such a song waits a
        // little (a minute when copies were found but all busy) and is tried again.
        const wait = job.code === 'download' ? RETRY_BUSY_AFTER : RETRY_AFTER;
        patchSong(p.id, song.key, { state: 'waiting', message: job.message, jobId: null, from: null, batch: null, retryAt: Date.now() + wait });
      } else {
        const change = songFromJob(job);
        // Progress comes several times a second: an update that changes nothing shown is skipped.
        const same =
          change.state === song.state && change.message === song.message && change.from === (song.from ?? null) && change.path === song.path && Math.round(change.progress! * 100) === Math.round(song.progress * 100);
        if (!same) patchSong(p.id, song.key, isSettled(change.state!) ? { ...change, batch: null } : change);
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
    code: job.state === 'failed' ? (job.code ?? null) : null,
  };
}

/** Logs in and follows downloads, ready to start songs. */
async function ready() {
  if (!downloadFolder()) throw new Error('Add a music folder in Settings → Music first.');
  await initMusicDownloads();
  await connectSoulseek();
  follow();
}

/** Starts (or resumes) downloading an import's songs. */
export async function startImport(id: string) {
  await ready();
  const p = getImport(id);
  if (!p) return;
  // Failed and cancelled songs are tried again (with their album again, where it has others waiting).
  patchImport(id, (x) => ({
    running: true,
    songs: x.songs.map((s) => (s.state === 'failed' || s.state === 'cancelled' ? { ...s, state: 'waiting', message: '', tries: 0, retryAt: undefined, solo: false } : s.state === 'waiting' ? { ...s, solo: false } : s)),
  }));
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
  wakeAt.delete(id);
  patchImport(id, () => ({ running: false }));
  for (const s of p.songs) {
    // (Cancelling one song of an album download cancels the whole download.)
    if (s.jobId && isBusy(s.state)) void invoke('slsk_cancel', { id: s.jobId }).catch(() => {});
    // A song still being matched is let go of: its start sees that and doesn't download it.
    if (s.state === 'matching') patchSong(id, s.key, { state: 'waiting', jobId: null, batch: null });
  }
}

/** Waits (s) between an import's sign-in attempts while Soulseek won't have it, longer each time:
 *  an account Soulseek has paused only gets paused longer by being tried every few seconds. */
const SIGN_IN_WAITS = [3, 30, 60, 120, 300, 600];
const signInTries = new Map<string, number>();

/** Each import's next wake-up, and when it's for. */
const wakeups = new Map<string, ReturnType<typeof setTimeout>>();
const wakeAt = new Map<string, number>();

/** Runs `pump` for the import at `at` (or sooner, if it's already due to run sooner). */
function wakeUp(id: string, at: number, then: () => void = () => void pump(id)) {
  const planned = wakeAt.get(id);
  if (wakeups.has(id) && planned != null && planned <= at) return;
  clearTimeout(wakeups.get(id));
  wakeAt.set(id, at);
  wakeups.set(
    id,
    setTimeout(() => {
      wakeups.delete(id);
      wakeAt.delete(id);
      then();
    }, Math.max(0, at - Date.now())),
  );
}

/** Starts the next songs while there's room; finishes the import when every song is settled. */
async function pump(id: string) {
  const p = getImport(id);
  if (!p) return;
  if (!p.running) {
    if (!p.songs.some((s) => isBusy(s.state))) void finish(id);
    return;
  }
  // While Soulseek reconnects, nothing new starts; the import picks up once it's back.
  const { state: status, message } = useMusicDownloads.getState().status;
  if (status !== 'online') {
    // Unless the user disconnected, or Soulseek turned the account down: then the import stops.
    if (disconnectedByUser() || (status === 'error' && loginRefused(message))) {
      stopImport(id);
      useLibraryStore.getState().toast(disconnectedByUser() ? `${p.name} stopped: Soulseek was disconnected.` : `${p.name} stopped: ${message}`, 'error');
      return;
    }
    if (!wakeups.has(id)) {
      // While the app reconnects by itself, the import just checks back; only a failed sign-in
      // makes it wait longer.
      const tries = signInTries.get(id) ?? 0;
      if (status === 'error') signInTries.set(id, tries + 1);
      const wait = status === 'error' ? SIGN_IN_WAITS[Math.min(tries, SIGN_IN_WAITS.length - 1)] : 3;
      wakeUp(id, Date.now() + wait * 1000, () => {
        if (useMusicDownloads.getState().status.state === 'connecting' || disconnectedByUser()) void pump(id);
        else void connectSoulseek().catch(() => {}).then(() => pump(id));
      });
    }
    return;
  }
  signInTries.delete(id);
  // Songs fetched together with their album count once: one search, one person.
  const units = (songs: ImportSong[]) => new Set(songs.map((s) => s.batch ?? s.key)).size;
  const busy = units(p.songs.filter((s) => isBusy(s.state)));
  const searching = units(p.songs.filter((s) => s.state === 'matching' || s.state === 'searching'));
  const room = Math.min(ACTIVE - busy, SEARCHING - searching);
  const now = Date.now();
  const waiting = p.songs.filter((s) => s.state === 'waiting');
  const next = albumGroups(waiting.filter((s) => !s.retryAt || s.retryAt <= now)).slice(0, Math.max(0, room));
  const later = waiting.filter((s) => s.retryAt && s.retryAt > now);
  // Songs waiting to be searched again start once their wait is over.
  if (later.length) wakeUp(id, Math.min(...later.map((s) => s.retryAt!)) + 50);
  if (!next.length) {
    if (!busy && !later.length) {
      patchImport(id, () => ({ running: false }));
      void finish(id);
    }
    return;
  }
  for (const unit of next) void (unit.length > 1 ? startAlbum(id, unit.map((s) => s.key)) : startSong(id, unit[0].key));
}

async function startSong(id: string, key: string, copy?: { user: string } & SharedFile) {
  const current = () => getImport(id)?.songs.find((s) => s.key === key);
  const before = current();
  if (!before) return;
  patchSong(id, key, { state: 'matching', message: '', jobId: null, retryAt: undefined, tries: copy ? before.tries : (before.tries ?? 0) + 1 });
  // Stopped meanwhile (it's no longer 'matching'): this start lets the song be.
  const stopped = () => current()?.state !== 'matching';
  let jobId: string | null = null;
  try {
    // The job's id is the song's before the job starts, so its first updates (even a quick
    // failure) are followed.
    const claim = () => {
      jobId = crypto.randomUUID();
      patchSong(id, key, { jobId });
    };
    const song = copy ? current()! : await prepareSong(id, key, stopped, before.tries, claim);
    if (!song) return;
    if (copy) claim();
    // (Set by `claim`, which the compiler can't follow.)
    const claimed = jobId as string | null;
    if (!claimed) return;
    const p = getImport(id)!;
    const request = await songRequest(claimed, id, p.source, song, importQuality(p), copy);
    if (stopped() || current()?.jobId !== jobId) return;
    const job = await invoke<AlbumJob>('slsk_download_song', { request });
    if (current()?.jobId !== job.id) {
      // Stopped (or handed on) while it was starting.
      void invoke('slsk_cancel', { id: job.id }).catch(() => {});
      return;
    }
    // Its updates may have come in first: the newest is kept.
    patchSong(id, key, songFromJob(useMusicDownloads.getState().jobs[job.id] ?? job));
  } catch (e) {
    const now = current();
    if (!now || now.state !== 'matching' || (now.jobId ?? null) !== jobId) return;
    const message = e instanceof Error ? e.message : String(e);
    const later = (wait: number) => patchSong(id, key, { state: 'waiting', message: '', jobId: null, tries: before.tries, retryAt: Date.now() + wait });
    if (notConnected(message) && !copy && getImport(id)?.running) {
      // Not this song's fault: it waits for Soulseek to be back.
      later(RECONNECT_PAUSE);
    } else if (/already downloading/i.test(message) && !copy && getImport(id)?.running) {
      // Another import is getting it: once that's done it's in the library.
      later(RETRY_AFTER);
    } else {
      patchSong(id, key, { state: 'failed', message, jobId: null });
    }
  } finally {
    void pump(id);
  }
}

/**
 * Matches a song (being started) to the store, and settles it when it needs no download: it's in
 * the library already, or it's listed twice and the other is fetched (it then waits for that one).
 * The song to download, or null when there's none (or it was `stopped` meanwhile). A song to
 * download is `claim`ed (given its job id) straight away, so a twin started meanwhile waits for it.
 */
async function prepareSong(id: string, key: string, stopped: () => boolean, tries: number | undefined, claim: () => void): Promise<ImportSong | null> {
  let song = getImport(id)?.songs.find((s) => s.key === key);
  if (!song) return null;
  if (!song.store || isVideoAlbum(song.store.album)) {
    const store = (await searchStore(song)) ?? song.store;
    if (stopped()) return null;
    if (store) patchSong(id, key, { store });
    song = { ...song, store };
  }
  const owned = inLibrary(song, song.store, useMusicPlayer.getState().library?.tracks ?? []);
  if (owned) {
    patchSong(id, key, { state: 'owned', trackId: owned.id, message: '', batch: null });
    return null;
  }
  // The same song listed twice: it's downloaded once (a song being matched counts once it has
  // claimed its job).
  const identity = songIdentity(song);
  const twin = getImport(id)!.songs.find(
    (o) => o.key !== key && (o.state === 'matching' ? !!o.jobId : isBusy(o.state) || o.state === 'done' || o.state === 'owned') && songIdentity(o) === identity,
  );
  if (twin && (twin.state === 'done' || twin.state === 'owned')) {
    patchSong(id, key, { state: twin.state, path: twin.path, trackId: twin.trackId, message: '', batch: null });
    return null;
  }
  if (twin) {
    patchSong(id, key, { state: 'waiting', message: '', tries, retryAt: Date.now() + RETRY_AFTER, batch: null });
    return null;
  }
  claim();
  return song;
}

/**
 * Starts songs of one album together: each is matched as a song started on its own is; the ones
 * still of the album are then fetched with one search for the album, from one person's folder.
 * Songs that turn out to be of another album, and the songs of a download that can't start, are
 * started on their own instead.
 */
async function startAlbum(id: string, keys: string[]) {
  const batch = crypto.randomUUID();
  const current = (key: string) => getImport(id)?.songs.find((s) => s.key === key);
  const tries = new Map(keys.map((k) => [k, current(k)?.tries]));
  patchImport(id, (p) => ({ songs: p.songs.map((s) => (keys.includes(s.key) ? { ...s, state: 'matching' as const, message: '', jobId: null, retryAt: undefined, batch } : s)) }));
  // Stopped meanwhile (it's no longer this download's song being matched).
  const mine = (key: string) => {
    const s = current(key);
    return s?.state === 'matching' && s.batch === batch;
  };
  const alone = (key: string, change: Partial<ImportSong> = {}) => {
    if (mine(key)) patchSong(id, key, { state: 'waiting', message: '', jobId: null, batch: null, solo: true, tries: tries.get(key), ...change });
  };
  let members: ImportSong[] = [];
  // Each song's job id is its own before the download starts, so its first updates are followed.
  const jobIds = new Map<string, string>();
  const claim = (key: string) => () => {
    jobIds.set(key, crypto.randomUUID());
    patchSong(id, key, { jobId: jobIds.get(key)! });
  };
  try {
    const prepared = await Promise.all(keys.map((key) => (mine(key) ? prepareSong(id, key, () => !mine(key), tries.get(key), claim(key)) : null)));
    members = prepared.filter((s): s is ImportSong => !!s && mine(s.key));
    // Matched to the store, a song may be of another album (or the same song twice): the album
    // most of them are of is fetched, and the others on their own.
    const count = new Map<string, number>();
    for (const s of members) {
      const k = albumKey(s);
      if (k) count.set(k, (count.get(k) ?? 0) + 1);
    }
    const [album] = [...count.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    const seen = new Set<string>();
    const together = members.filter((s) => {
      if (albumKey(s) !== album || seen.has(songIdentity(s))) return false;
      seen.add(songIdentity(s));
      return true;
    });
    for (const s of members) if (!together.includes(s)) alone(s.key);
    members = together;
    if (members.length < 2) {
      for (const s of members) alone(s.key);
      return;
    }
    const p = getImport(id)!;
    if (!p.running || !members.every((s) => mine(s.key))) {
      for (const s of members) alone(s.key, { solo: false });
      return;
    }
    const quality = importQuality(p);
    const songs = await Promise.all(members.map((s) => songRequest(jobIds.get(s.key)!, id, p.source, s, quality)));
    const of = albumOf(members[0])!;
    const ours = (key: string) => mine(key) && current(key)?.jobId === jobIds.get(key);
    if (!getImport(id)?.running || !members.every((s) => ours(s.key))) {
      for (const s of members) alone(s.key, { solo: false });
      return;
    }
    const jobs = await invoke<AlbumJob[]>('slsk_download_album_songs', {
      request: { id: batch, group: id, album: of.album, albumArtist: of.artist, quality, destination: songs[0].destination, songs },
    });
    if (!Array.isArray(jobs)) throw new Error('The album download didn’t start.');
    // (A song may have ended already: its update came in first.)
    if (!getImport(id)?.running) {
      // Stopped while it was starting: the whole download is cancelled.
      void invoke('slsk_cancel', { id: jobs[0]?.id }).catch(() => {});
      return;
    }
    // Their updates may have come in first: the newest are kept.
    for (const job of jobs) {
      const song = members.find((s) => jobIds.get(s.key) === job.id);
      if (song && current(song.key)?.state === 'matching') patchSong(id, song.key, songFromJob(useMusicDownloads.getState().jobs[job.id] ?? job));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Not these songs' fault: they wait for Soulseek to be back, still together. Otherwise
    // they're each searched for on their own.
    const later = notConnected(message) && getImport(id)?.running;
    for (const key of keys) alone(key, later ? { solo: false, retryAt: Date.now() + RECONNECT_PAUSE } : {});
  } finally {
    void pump(id);
  }
}

/** What to ask the app to download for one song (from `copy` when the user picked a file). */
async function songRequest(jobId: string, group: string, source: ImportSource, song: ImportSong, quality: MusicQuality, copy?: { user: string } & SharedFile) {
  const destination = downloadFolder();
  if (!destination) throw new Error('Add a music folder in Settings → Music first.');
  const store = song.store;
  // A video's thumbnail isn't a cover.
  const cover = store?.cover ?? (source === 'youtube' ? null : song.cover);
  const coverPath = cover ? await invoke<string>('live_artwork', { url: cover }).catch(() => null) : null;
  const artists = songArtists(song);
  return {
    id: jobId,
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
  };
}

/** Tries a song again (searching for it anew): just that song when the import isn't running. */
export function retrySong(id: string, key: string) {
  patchSong(id, key, { state: 'waiting', message: '', jobId: null, tries: 0, retryAt: undefined, batch: null, solo: true });
  const p = getImport(id);
  if (p?.running) void pump(id);
  else
    void ready()
      .then(() => startSong(id, key))
      .catch((e) => patchSong(id, key, { state: 'failed', message: e instanceof Error ? e.message : String(e) }));
}

/** Downloads a file the user picked for a song. */
export async function pickSongFile(id: string, key: string, file: { user: string } & SharedFile) {
  await ready();
  await startSong(id, key, file);
}

const pathKey = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Imports whose playlist must be made again once the current making is done (a song came in meanwhile). */
const finishAgain = new Set<string>();
/** The songs each import's playlist was last made with: the same again changes nothing. */
const finishedWith = new Map<string, string>();

/** Scans the new songs in and makes (or updates) the playlist in the music library. */
async function finish(id: string) {
  const p = getImport(id);
  if (!p || !p.songs.some((s) => s.state === 'done' || s.state === 'owned')) return;
  if (p.finishing) {
    finishAgain.add(id);
    return;
  }
  const settled = p.songs.map((s) => `${s.state}:${s.path ?? s.trackId ?? ''}`).join('|');
  if (finishedWith.get(id) === settled && p.playlistId != null) return;
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
    // Importing the same playlist again (its link again, or its full CSV after the first part
    // from a page that showed only that) updates the playlist an earlier import of it made,
    // rather than adding a second. Another playlist that only shares its name is left alone.
    const samePlaylist = (o: PlaylistImport) =>
      (o.source === now.source && !!o.sourceId && o.sourceId === now.sourceId && now.source !== 'list') || (!!o.partial && now.source === 'list' && o.name === now.name);
    const earlier = Object.values(usePlaylistImports.getState().imports).find((o) => o.id !== id && o.playlistId != null && playlists.some((x) => x.id === o.playlistId) && samePlaylist(o))?.playlistId;
    // An empty playlist of the same name is taken over too (an earlier import of it whose songs
    // were deleted, or whose import was removed): there's nothing in it to lose, and a second
    // playlist of the same name would only confuse.
    const empty = playlists.find((x) => x.name === now.name && x.trackIds.length === 0)?.id;
    const target = now.playlistId != null && playlists.some((x) => x.id === now.playlistId) ? now.playlistId : (earlier ?? empty ?? null);
    let playlistId: number | null = target;
    if (target != null) {
      await setPlaylistTracks(target, ids);
    } else {
      playlistId = (await createPlaylist(now.name, ids))?.id ?? null;
    }
    patchImport(id, () => ({ playlistId }));
    // The source playlist's artwork becomes its cover (kept on this computer, so it shows offline
    // and after the address stops working). A cover the user picked stays; no artwork isn't fatal.
    if (playlistId != null && now.cover) await importPlaylistCover(playlistId, now.cover).catch((e) => console.warn('[playlist import] artwork not saved', e));
    finishedWith.set(id, settled);
    const missing = now.songs.filter((s) => s.state === 'failed' || s.state === 'cancelled').length;
    useLibraryStore.getState().toast(`${now.name} is in your music library${missing ? ` (${missing} song${missing === 1 ? '' : 's'} not found)` : ''}`, 'success');
  } catch (e) {
    useLibraryStore.getState().toast(`Couldn’t make the playlist: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    patchImport(id, () => ({ finishing: false }));
    if (finishAgain.delete(id)) void finish(id);
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
