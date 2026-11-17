import type Database from '@tauri-apps/plugin-sql';
import { getDb } from './db';
import { assembleLibrary } from '../music/library';
import { albumFolder, albumKey, guessFromPath, nameKey, primaryArtist, resolveTags, settleAlbumArtist } from '../music/match';
import type { MusicLibrary, MusicPlaylist, MusicTrack } from '../music/types';

/**
 * Music library tables. Songs, albums and artists are shared by every profile; plays, favourites
 * and playlists belong to one profile. Created on first use, in the same style as `db.ts`.
 */
export const MUSIC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS music_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE          -- lower-cased name, so "ABBA" and "Abba" are one artist
  )`,
  `CREATE TABLE IF NOT EXISTS music_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    artist_id INTEGER NOT NULL,            -- album artist
    created_at INTEGER NOT NULL,
    UNIQUE (artist_id, title_key)
  )`,
  `CREATE TABLE IF NOT EXISTS music_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    file_mtime INTEGER NOT NULL,
    file_size INTEGER,
    title TEXT NOT NULL,
    artist_id INTEGER NOT NULL,
    album_id INTEGER NOT NULL,
    track_no INTEGER,
    disc_no INTEGER,
    year INTEGER,
    genre TEXT,
    duration REAL NOT NULL DEFAULT 0,
    codec TEXT,
    sample_rate INTEGER,
    bit_depth INTEGER,
    bitrate INTEGER,
    art TEXT,                              -- cached cover file name (music-art folder)
    lyrics TEXT,                           -- embedded or sidecar LRC / plain text
    lyrics_source TEXT,                    -- 'embedded' | 'sidecar'
    created_at INTEGER NOT NULL
  )`,
  // Online lyrics answers (including "not found"), so each song is looked up once.
  `CREATE TABLE IF NOT EXISTS music_lyrics_cache (
    track_id INTEGER PRIMARY KEY,
    synced TEXT,
    plain TEXT,
    instrumental INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS music_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS music_playlist_tracks (
    playlist_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS music_plays (
    profile_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    played_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS music_favourites (
    profile_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, track_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_tracks_album ON music_tracks(album_id)`,
  `CREATE INDEX IF NOT EXISTS idx_music_plays ON music_plays(profile_id, track_id)`,
  `CREATE INDEX IF NOT EXISTS idx_music_playlists_profile ON music_playlists(profile_id)`,
];

/** Columns added to music tables after they first shipped. */
const MUSIC_ADDED_COLUMNS: Record<string, [string, string][]> = {
  // Which service answered ('netease' | 'lrclib' | 'none'); older rows (null) are looked up again.
  music_lyrics_cache: [['provider', 'TEXT']],
};

let ready: Promise<Database> | null = null;

export function musicDb(): Promise<Database> {
  if (!ready) {
    ready = (async () => {
      const db = await getDb();
      for (const stmt of MUSIC_SCHEMA) await db.execute(stmt);
      for (const [table, columns] of Object.entries(MUSIC_ADDED_COLUMNS)) {
        const existing = new Set((await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`)).map((c) => c.name));
        for (const [name, type] of columns) if (!existing.has(name)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      return db;
    })();
    ready.catch(() => (ready = null));
  }
  return ready;
}

/** For tests: forget the schema check (a fresh database). */
export function resetMusicDb() {
  ready = null;
}

const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(', ');

function chunks<T>(list: T[], size = 300): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const key = (s: string) => s.trim().toLocaleLowerCase();

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** One file as read by the Rust scanner (`music_scan`). */
export interface MusicFile {
  file_path: string;
  file_size: number;
  mtime: number;
  title: string | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
  genre: string | null;
  track_no: number | null;
  track_total: number | null;
  disc_no: number | null;
  disc_total: number | null;
  year: number | null;
  duration: number;
  codec: string;
  sample_rate: number | null;
  bit_depth: number | null;
  bitrate: number | null;
  channels: number | null;
  cover: string | null;
  lyrics: string | null;
  lyrics_source: string | null;
  error: string | null;
}

export async function musicFileIndex(): Promise<Map<string, { id: number; mtime: number }>> {
  const db = await musicDb();
  const rows = await db.select<{ id: number; file_path: string; file_mtime: number }[]>('SELECT id, file_path, file_mtime FROM music_tracks');
  return new Map(rows.map((r) => [r.file_path, { id: r.id, mtime: r.file_mtime }]));
}

async function ensureArtist(db: Database, cache: Map<string, number>, name: string): Promise<number> {
  const k = nameKey(name) || key(name);
  const hit = cache.get(k);
  if (hit) return hit;
  await db.execute('INSERT INTO music_artists (name, name_key) VALUES ($1, $2) ON CONFLICT(name_key) DO NOTHING', [name.trim(), k]);
  const [row] = await db.select<{ id: number }[]>('SELECT id FROM music_artists WHERE name_key = $1', [k]);
  cache.set(k, row.id);
  return row.id;
}

async function ensureAlbum(db: Database, cache: Map<string, number>, title: string, artistId: number, now: number): Promise<number> {
  const tk = albumKey(title) || key(title);
  const k = `${artistId}|${tk}`;
  const hit = cache.get(k);
  if (hit) return hit;
  await db.execute('INSERT INTO music_albums (title, title_key, artist_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT(artist_id, title_key) DO NOTHING', [title.trim(), tk, artistId, now]);
  const [row] = await db.select<{ id: number }[]>('SELECT id FROM music_albums WHERE artist_id = $1 AND title_key = $2', [artistId, tk]);
  cache.set(k, row.id);
  return row.id;
}

/** Album artists of songs already in the library from the same album folder (not in this batch), so new songs join their album. */
async function folderArtists(db: Database, folder: string, album: string, skip: Set<string>): Promise<string[]> {
  if (!folder) return [];
  // `albumFolder` is lower-case with forward slashes; char(92) is a backslash.
  const like = `${folder.replace(/[!%_]/g, (c) => `!${c}`)}/%`;
  const rows = await db.select<{ file_path: string; artist: string; album: string }[]>(
    `SELECT t.file_path, aa.name AS artist, al.title AS album FROM music_tracks t
     JOIN music_albums al ON al.id = t.album_id JOIN music_artists aa ON aa.id = al.artist_id
     WHERE lower(replace(t.file_path, char(92), '/')) LIKE $1 ESCAPE '!' LIMIT 400`,
    [like],
  );
  const k = albumKey(album);
  return rows.filter((r) => !skip.has(r.file_path) && albumFolder(r.file_path) === folder && albumKey(r.album) === k).map((r) => r.artist);
}

/**
 * Adds new and updates changed files. Missing tags are filled from the file and folder names;
 * songs without an album artist are grouped by album folder (featured guests don't split an album,
 * and mixed-artist albums become "Various Artists"). `roots` are the music folders.
 */
export async function upsertMusicFiles(files: MusicFile[], now = Date.now(), roots: string[] = []) {
  if (!files.length) return;
  const db = await musicDb();
  const artists = new Map<string, number>();
  const albums = new Map<string, number>();
  const resolved = files.map((f) => ({ f, tags: resolveTags(f, roots), folder: albumFolder(f.file_path) }));

  // Album artist for untagged albums, decided once per album folder.
  const groups = new Map<string, typeof resolved>();
  for (const r of resolved) {
    if (r.tags.albumArtistTagged) continue;
    const g = `${r.folder}|${albumKey(r.tags.album)}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const batch = new Set(files.map((f) => f.file_path));
  for (const list of groups.values()) {
    const first = list[0];
    const others = first.tags.album === 'Unknown Album' ? [] : await folderArtists(db, first.folder, first.tags.album, batch);
    const folderArtist = guessFromPath(first.f.file_path, roots).albumArtist;
    const albumArtist = first.tags.album === 'Unknown Album' ? null : settleAlbumArtist(list.map((r) => r.tags.artist), others, folderArtist);
    for (const r of list) r.tags.albumArtist = albumArtist ?? primaryArtist(r.tags.artist);
  }

  for (const { f, tags } of resolved) {
    const artistId = await ensureArtist(db, artists, tags.artist);
    const albumArtistId = await ensureArtist(db, artists, tags.albumArtist || tags.artist);
    const albumId = await ensureAlbum(db, albums, tags.album, albumArtistId, now);
    await db.execute(
      `INSERT INTO music_tracks (file_path, file_mtime, file_size, title, artist_id, album_id, track_no, disc_no, year, genre, duration, codec, sample_rate, bit_depth, bitrate, art, lyrics, lyrics_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT(file_path) DO UPDATE SET file_mtime = excluded.file_mtime, file_size = excluded.file_size, title = excluded.title,
         artist_id = excluded.artist_id, album_id = excluded.album_id, track_no = excluded.track_no, disc_no = excluded.disc_no,
         year = excluded.year, genre = excluded.genre, duration = excluded.duration, codec = excluded.codec, sample_rate = excluded.sample_rate,
         bit_depth = excluded.bit_depth, bitrate = excluded.bitrate, art = excluded.art, lyrics = excluded.lyrics, lyrics_source = excluded.lyrics_source`,
      [
        f.file_path,
        f.mtime,
        f.file_size,
        tags.title,
        artistId,
        albumId,
        tags.trackNo,
        tags.discNo,
        tags.year,
        f.genre,
        f.duration || 0,
        f.codec,
        f.sample_rate,
        f.bit_depth,
        f.bitrate,
        f.cover,
        f.lyrics,
        f.lyrics_source,
        now,
      ],
    );
  }
  // Changed lyrics may make a cached online lookup obsolete.
  await db.execute(`DELETE FROM music_lyrics_cache WHERE track_id IN (SELECT id FROM music_tracks WHERE lyrics IS NOT NULL)`);
}

/** Removes songs whose files are gone, with their playlist entries, plays and favourites. */
export async function removeMusicPaths(paths: string[]) {
  if (!paths.length) return;
  const db = await musicDb();
  for (const batch of chunks(paths)) {
    const ids = (await db.select<{ id: number }[]>(`SELECT id FROM music_tracks WHERE file_path IN (${placeholders(batch.length)})`, batch)).map((r) => r.id);
    if (!ids.length) continue;
    const list = placeholders(ids.length);
    for (const table of ['music_playlist_tracks', 'music_plays', 'music_favourites', 'music_lyrics_cache']) await db.execute(`DELETE FROM ${table} WHERE track_id IN (${list})`, ids);
    await db.execute(`DELETE FROM music_tracks WHERE id IN (${list})`, ids);
  }
  await pruneMusic();
}

/** Albums and artists without songs. */
export async function pruneMusic() {
  const db = await musicDb();
  await db.execute('DELETE FROM music_albums WHERE id NOT IN (SELECT DISTINCT album_id FROM music_tracks)');
  await db.execute('DELETE FROM music_artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM music_tracks) AND id NOT IN (SELECT DISTINCT artist_id FROM music_albums)');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface TrackRow {
  id: number;
  title: string;
  artist_id: number;
  artist: string;
  album_id: number;
  album: string;
  album_artist_id: number;
  album_artist: string;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  genre: string | null;
  duration: number;
  codec: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  bitrate: number | null;
  art: string | null;
  created_at: number;
  has_lyrics: number;
  favourite: number;
  plays: number | null;
  last_played: number | null;
}

const toTrack = (r: TrackRow): MusicTrack => ({
  id: r.id,
  title: r.title,
  artist: r.artist,
  artistId: r.artist_id,
  album: r.album,
  albumId: r.album_id,
  albumArtist: r.album_artist,
  albumArtistId: r.album_artist_id,
  trackNo: r.track_no,
  discNo: r.disc_no,
  year: r.year,
  genre: r.genre,
  duration: r.duration,
  codec: r.codec ?? '',
  sampleRate: r.sample_rate ?? null,
  bitDepth: r.bit_depth ?? null,
  bitrate: r.bitrate ?? null,
  art: r.art,
  favourite: !!r.favourite,
  plays: r.plays ?? 0,
  lastPlayed: r.last_played ?? null,
  addedAt: r.created_at,
  hasLyrics: !!r.has_lyrics,
});

export async function loadMusic(profileId: number): Promise<MusicLibrary> {
  const db = await musicDb();
  const rows = await db.select<TrackRow[]>(
    `SELECT t.id, t.title, t.artist_id, ar.name AS artist, t.album_id, al.title AS album, al.artist_id AS album_artist_id, aa.name AS album_artist,
            t.track_no, t.disc_no, t.year, t.genre, t.duration, t.codec, t.sample_rate, t.bit_depth, t.bitrate, t.art, t.created_at, (t.lyrics IS NOT NULL) AS has_lyrics,
            (f.track_id IS NOT NULL) AS favourite, p.plays, p.last_played
     FROM music_tracks t
     JOIN music_artists ar ON ar.id = t.artist_id
     JOIN music_albums al ON al.id = t.album_id
     JOIN music_artists aa ON aa.id = al.artist_id
     LEFT JOIN music_favourites f ON f.track_id = t.id AND f.profile_id = $1
     LEFT JOIN (SELECT track_id, COUNT(*) AS plays, MAX(played_at) AS last_played FROM music_plays WHERE profile_id = $1 GROUP BY track_id) p ON p.track_id = t.id`,
    [profileId],
  );
  return assembleLibrary(rows.map(toTrack), await listPlaylists(profileId));
}

export interface MusicTrackFile {
  id: number;
  file_path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  codec: string | null;
  lyrics: string | null;
  lyrics_source: string | null;
}

export async function musicTrackFile(id: number): Promise<MusicTrackFile | null> {
  if (!Number.isInteger(id)) return null;
  const db = await musicDb();
  const rows = await db.select<MusicTrackFile[]>(
    `SELECT t.id, t.file_path, t.title, ar.name AS artist, al.title AS album, t.duration, t.codec, t.lyrics, t.lyrics_source
     FROM music_tracks t JOIN music_artists ar ON ar.id = t.artist_id JOIN music_albums al ON al.id = t.album_id WHERE t.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface CachedLyrics {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  fetched_at: number;
  provider: string | null;
}

export async function cachedLyrics(trackId: number): Promise<CachedLyrics | null> {
  const db = await musicDb();
  const rows = await db.select<(Omit<CachedLyrics, 'instrumental'> & { instrumental: number })[]>('SELECT synced, plain, instrumental, fetched_at, provider FROM music_lyrics_cache WHERE track_id = $1', [trackId]);
  return rows[0] ? { ...rows[0], instrumental: !!rows[0].instrumental } : null;
}

export async function saveLyricsCache(trackId: number, l: { synced: string | null; plain: string | null; instrumental: boolean; provider: string }, now = Date.now()) {
  const db = await musicDb();
  await db.execute(
    `INSERT INTO music_lyrics_cache (track_id, synced, plain, instrumental, fetched_at, provider) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(track_id) DO UPDATE SET synced = excluded.synced, plain = excluded.plain, instrumental = excluded.instrumental, fetched_at = excluded.fetched_at, provider = excluded.provider`,
    [trackId, l.synced, l.plain, l.instrumental ? 1 : 0, now, l.provider],
  );
}

// ---------------------------------------------------------------------------
// Per-profile state
// ---------------------------------------------------------------------------

async function trackExists(db: Database, id: number) {
  return Number.isInteger(id) && (await db.select<{ id: number }[]>('SELECT id FROM music_tracks WHERE id = $1', [id])).length > 0;
}

export async function recordPlay(profileId: number, trackId: number, now = Date.now()) {
  const db = await musicDb();
  if (!(await trackExists(db, trackId))) return false;
  await db.execute('INSERT INTO music_plays (profile_id, track_id, played_at) VALUES ($1, $2, $3)', [profileId, trackId, now]);
  return true;
}

export async function setFavourite(profileId: number, trackId: number, value: boolean, now = Date.now()) {
  const db = await musicDb();
  if (value) {
    if (!(await trackExists(db, trackId))) return false;
    await db.execute('INSERT OR IGNORE INTO music_favourites (profile_id, track_id, added_at) VALUES ($1, $2, $3)', [profileId, trackId, now]);
  } else {
    await db.execute('DELETE FROM music_favourites WHERE profile_id = $1 AND track_id = $2', [profileId, trackId]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export class PlaylistNotFound extends Error {
  constructor() {
    super('Playlist not found');
  }
}

export const PLAYLIST_NAME_MAX = 120;
export const PLAYLIST_TRACKS_MAX = 5000;

export function cleanPlaylistName(name: unknown): string {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, PLAYLIST_NAME_MAX);
  return s || 'New Playlist';
}

/** Whole-number ids only, capped. */
export function cleanTrackIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, PLAYLIST_TRACKS_MAX);
}

export async function listPlaylists(profileId: number): Promise<MusicPlaylist[]> {
  const db = await musicDb();
  const lists = await db.select<{ id: number; name: string; updated_at: number }[]>('SELECT id, name, updated_at FROM music_playlists WHERE profile_id = $1 ORDER BY updated_at DESC', [profileId]);
  if (!lists.length) return [];
  const entries = await db.select<{ playlist_id: number; track_id: number }[]>(
    `SELECT pt.playlist_id, pt.track_id FROM music_playlist_tracks pt JOIN music_playlists p ON p.id = pt.playlist_id
     WHERE p.profile_id = $1 ORDER BY pt.playlist_id, pt.position`,
    [profileId],
  );
  const byList = new Map<number, number[]>();
  for (const e of entries) byList.set(e.playlist_id, [...(byList.get(e.playlist_id) ?? []), e.track_id]);
  return lists.map((l) => ({ id: l.id, name: l.name, updatedAt: l.updated_at, trackIds: byList.get(l.id) ?? [] }));
}

async function ownPlaylist(db: Database, profileId: number, id: number) {
  if (!Number.isInteger(id)) throw new PlaylistNotFound();
  const rows = await db.select<{ id: number }[]>('SELECT id FROM music_playlists WHERE id = $1 AND profile_id = $2', [id, profileId]);
  if (!rows.length) throw new PlaylistNotFound();
}

/** Keeps only ids of songs that exist, in order. */
async function existingIds(db: Database, ids: number[]): Promise<number[]> {
  const found = new Set<number>();
  for (const batch of chunks([...new Set(ids)])) {
    for (const r of await db.select<{ id: number }[]>(`SELECT id FROM music_tracks WHERE id IN (${placeholders(batch.length)})`, batch)) found.add(r.id);
  }
  return ids.filter((id) => found.has(id));
}

async function writeEntries(db: Database, playlistId: number, ids: number[], from: number) {
  for (const [n, batch] of chunks(ids, 250).entries()) {
    const values = batch.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
    const params: number[] = [playlistId];
    batch.forEach((id, i) => params.push(from + n * 250 + i, id));
    await db.execute(`INSERT INTO music_playlist_tracks (playlist_id, position, track_id) VALUES ${values}`, params);
  }
}

export async function createPlaylist(profileId: number, name: unknown, trackIds: unknown = [], now = Date.now()): Promise<MusicPlaylist> {
  const db = await musicDb();
  const clean = cleanPlaylistName(name);
  const result = await db.execute('INSERT INTO music_playlists (profile_id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)', [profileId, clean, now]);
  const id = Number(result.lastInsertId);
  const ids = await existingIds(db, cleanTrackIds(trackIds));
  await writeEntries(db, id, ids, 0);
  return { id, name: clean, trackIds: ids, updatedAt: now };
}

export async function renamePlaylist(profileId: number, id: number, name: unknown, now = Date.now()) {
  const db = await musicDb();
  await ownPlaylist(db, profileId, id);
  await db.execute('UPDATE music_playlists SET name = $2, updated_at = $3 WHERE id = $1', [id, cleanPlaylistName(name), now]);
}

export async function deletePlaylist(profileId: number, id: number) {
  const db = await musicDb();
  await ownPlaylist(db, profileId, id);
  await db.execute('DELETE FROM music_playlist_tracks WHERE playlist_id = $1', [id]);
  await db.execute('DELETE FROM music_playlists WHERE id = $1', [id]);
}

/** Replaces the songs (reorder, remove and add all use this). */
export async function setPlaylistTracks(profileId: number, id: number, trackIds: unknown, now = Date.now()) {
  const db = await musicDb();
  await ownPlaylist(db, profileId, id);
  const ids = await existingIds(db, cleanTrackIds(trackIds));
  await db.execute('DELETE FROM music_playlist_tracks WHERE playlist_id = $1', [id]);
  await writeEntries(db, id, ids, 0);
  await db.execute('UPDATE music_playlists SET updated_at = $2 WHERE id = $1', [id, now]);
  return ids;
}

export async function addToPlaylist(profileId: number, id: number, trackIds: unknown, now = Date.now()) {
  const db = await musicDb();
  await ownPlaylist(db, profileId, id);
  const [{ n, last }] = await db.select<{ n: number; last: number | null }[]>('SELECT COUNT(*) AS n, MAX(position) AS last FROM music_playlist_tracks WHERE playlist_id = $1', [id]);
  const ids = (await existingIds(db, cleanTrackIds(trackIds))).slice(0, Math.max(0, PLAYLIST_TRACKS_MAX - n));
  await writeEntries(db, id, ids, (last ?? -1) + 1);
  await db.execute('UPDATE music_playlists SET updated_at = $2 WHERE id = $1', [id, now]);
  return ids;
}
