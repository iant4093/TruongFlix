import Database from '@tauri-apps/plugin-sql';
import type {
  EpisodeRow,
  MovieRow,
  PlayableType,
  SeriesRow,
  Settings,
  SubtitleRow,
  TechInfo,
  TrashRow,
  TrashSnapshot,
} from '../types/media';

const DB_URL = 'sqlite:truongflix.db';

// Note: movies.tmdb_id is indexed rather than UNIQUE so that several versions of the
// same film (e.g. a 1080p and a 4K remux) can coexist; the UI de-duplicates them.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER,
    file_path TEXT UNIQUE NOT NULL,
    raw_filename TEXT NOT NULL,
    file_mtime INTEGER NOT NULL,
    title TEXT NOT NULL,
    original_title TEXT,
    year INTEGER,
    overview TEXT,
    tagline TEXT,
    runtime INTEGER,
    vote_average REAL,
    genres TEXT,
    cast_crew TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    logo_path TEXT,
    resolution TEXT,
    video_codec TEXT,
    hdr_format TEXT,
    audio_codec TEXT,
    progress_seconds INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    watched BOOLEAN DEFAULT 0,
    my_list BOOLEAN DEFAULT 0,
    last_watched_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tv_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER UNIQUE NOT NULL,
    folder_path TEXT,
    title TEXT NOT NULL,
    year INTEGER,
    overview TEXT,
    vote_average REAL,
    genres TEXT,
    cast_crew TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    logo_path TEXT,
    number_of_seasons INTEGER DEFAULT 1,
    my_list BOOLEAN DEFAULT 0,
    last_watched_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    tmdb_episode_id INTEGER,
    file_path TEXT UNIQUE NOT NULL,
    raw_filename TEXT NOT NULL,
    file_mtime INTEGER NOT NULL,
    season_number INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    overview TEXT,
    still_path TEXT,
    air_date TEXT,
    runtime INTEGER,
    resolution TEXT,
    video_codec TEXT,
    hdr_format TEXT,
    audio_codec TEXT,
    progress_seconds INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    watched BOOLEAN DEFAULT 0,
    last_watched_at DATETIME,
    FOREIGN KEY (series_id) REFERENCES tv_series(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS subtitles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type TEXT NOT NULL,         -- 'movie' | 'episode'
    media_id INTEGER NOT NULL,
    language TEXT NOT NULL,
    file_path TEXT NOT NULL,
    source TEXT NOT NULL,             -- 'opensubtitles' | 'local'
    release_name TEXT,
    hash_match BOOLEAN DEFAULT 0,
    opensubtitles_file_id INTEGER,
    selected BOOLEAN DEFAULT 0,       -- passed to VLC via --sub-file
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (media_type, media_id, file_path)
  )`,
  `CREATE TABLE IF NOT EXISTS trash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,               -- 'movie' | 'tv' | 'episode'
    poster_path TEXT,
    entry_dir TEXT NOT NULL,          -- <media root>/.truongflix-trash/<entry>
    items TEXT NOT NULL,              -- JSON [{from, to}] file moves to undo on restore
    snapshot TEXT NOT NULL,           -- JSON library rows (progress, My List, matches) to re-insert
    size_bytes INTEGER DEFAULT 0,
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_movies_tmdb ON movies(tmdb_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id, season_number, episode_number)`,
];

/** Columns added after the first release; created on startup if an older database lacks them. */
const ADDED_COLUMNS: Record<string, [string, string][]> = {
  movies: [
    ['imdb_id', 'TEXT'], // NULL = not looked up yet, '' = TMDB has no IMDb id
    ['imdb_rating', 'REAL'],
    ['imdb_votes', 'INTEGER'],
  ],
  tv_series: [
    ['imdb_id', 'TEXT'],
    ['imdb_rating', 'REAL'],
    ['imdb_votes', 'INTEGER'],
    ['imdb_season_ratings', 'TEXT'], // JSON {"1": {"rating": 8.4, "count": 9}}
  ],
  episodes: [
    ['imdb_id', 'TEXT'],
    ['imdb_rating', 'REAL'],
    ['imdb_votes', 'INTEGER'],
  ],
};

async function migrate(db: Database) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set((await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`)).map((c) => c.name));
    for (const [name, type] of columns) {
      if (!existing.has(name)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  await db.execute('CREATE INDEX IF NOT EXISTS idx_movies_imdb ON movies(imdb_id)');
}

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load(DB_URL);
      for (const stmt of SCHEMA) await db.execute(stmt);
      await migrate(db);
      await db.execute('PRAGMA foreign_keys = ON');
      return db;
    })();
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

async function exec(sql: string, params: unknown[] = []) {
  const db = await getDb();
  return db.execute(sql, params);
}

async function select<T>(sql: string, params: unknown[] = []): Promise<T> {
  const db = await getDb();
  return db.select<T>(sql, params);
}

const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
  const rows = await select<{ key: string; value: string }[]>('SELECT key, value FROM settings');
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let dirs: string[] = [];
  try {
    dirs = JSON.parse(map.media_directories ?? '[]');
  } catch {
    dirs = [];
  }
  return {
    tmdb_api_key: map.tmdb_api_key ?? '',
    vlc_executable_path: map.vlc_executable_path ?? '',
    media_directories: Array.isArray(dirs) ? dirs : [],
    opensubtitles_api_key: map.opensubtitles_api_key ?? '',
    opensubtitles_username: map.opensubtitles_username ?? '',
    opensubtitles_password: map.opensubtitles_password ?? '',
    subtitle_language: map.subtitle_language || 'en',
    organize_loose_files: map.organize_loose_files !== 'false',
    imdb_enabled: map.imdb_enabled !== 'false',
    imdb_last_sync: map.imdb_last_sync ?? '',
    player_engine: map.player_engine === 'vlc' ? 'vlc' : 'builtin',
    updates_auto_check: map.updates_auto_check !== 'false',
    updates_last_check: map.updates_last_check ?? '',
  };
}

export async function saveSetting(key: keyof Settings, value: string | string[] | boolean) {
  const stored = Array.isArray(value) ? JSON.stringify(value) : String(value);
  await exec(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, stored],
  );
}

// ---------------------------------------------------------------------------
// Library reads
// ---------------------------------------------------------------------------

export async function loadLibrary() {
  const [movies, series, episodes] = await Promise.all([
    select<MovieRow[]>('SELECT * FROM movies'),
    select<SeriesRow[]>('SELECT * FROM tv_series'),
    select<EpisodeRow[]>('SELECT * FROM episodes ORDER BY series_id, season_number, episode_number'),
  ]);
  return { movies, series, episodes };
}

export interface IndexedFile {
  type: 'movie' | 'episode';
  id: number;
  mtime: number;
}

/** file_path -> existing row, used for incremental diffing. */
export async function getFileIndex(): Promise<Map<string, IndexedFile>> {
  const [movies, episodes] = await Promise.all([
    select<{ id: number; file_path: string; file_mtime: number }[]>('SELECT id, file_path, file_mtime FROM movies'),
    select<{ id: number; file_path: string; file_mtime: number }[]>('SELECT id, file_path, file_mtime FROM episodes'),
  ]);
  const map = new Map<string, IndexedFile>();
  for (const m of movies) map.set(m.file_path, { type: 'movie', id: m.id, mtime: m.file_mtime });
  for (const e of episodes) map.set(e.file_path, { type: 'episode', id: e.id, mtime: e.file_mtime });
  return map;
}

export interface MatchHint {
  kind: 'movie' | 'tv';
  tmdbId: number;
}

/** file_path -> previously resolved TMDB id, so refreshes keep manual Fix Match choices. */
export async function getMatchHints(): Promise<Map<string, MatchHint>> {
  const [movies, episodes] = await Promise.all([
    select<{ file_path: string; tmdb_id: number }[]>('SELECT file_path, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL'),
    select<{ file_path: string; tmdb_id: number }[]>(
      'SELECT e.file_path, s.tmdb_id FROM episodes e JOIN tv_series s ON s.id = e.series_id WHERE s.tmdb_id > 0',
    ),
  ]);
  const map = new Map<string, MatchHint>();
  for (const m of movies) map.set(m.file_path, { kind: 'movie', tmdbId: m.tmdb_id });
  for (const e of episodes) map.set(e.file_path, { kind: 'tv', tmdbId: e.tmdb_id });
  return map;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface MovieMetadata {
  tmdb_id: number | null;
  title: string;
  original_title: string | null;
  year: number | null;
  overview: string | null;
  tagline: string | null;
  runtime: number | null;
  vote_average: number | null;
  genres: string[];
  cast_crew: unknown[];
  poster_path: string | null;
  backdrop_path: string | null;
  logo_path: string | null;
  /** From TMDB; null = unknown, '' = TMDB has none. */
  imdb_id: string | null;
}

export interface FileInfo {
  file_path: string;
  raw_filename: string;
  file_mtime: number;
}

export async function upsertMovie(file: FileInfo, meta: MovieMetadata, tech: TechInfo) {
  await exec(
    `INSERT INTO movies (tmdb_id, file_path, raw_filename, file_mtime, title, original_title, year, overview, tagline,
       runtime, vote_average, genres, cast_crew, poster_path, backdrop_path, logo_path,
       resolution, video_codec, hdr_format, audio_codec, imdb_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT(file_path) DO UPDATE SET
       imdb_rating = CASE WHEN movies.imdb_id IS excluded.imdb_id THEN movies.imdb_rating END,
       imdb_votes = CASE WHEN movies.imdb_id IS excluded.imdb_id THEN movies.imdb_votes END,
       imdb_id = excluded.imdb_id,
       tmdb_id = excluded.tmdb_id, raw_filename = excluded.raw_filename, file_mtime = excluded.file_mtime,
       title = excluded.title, original_title = excluded.original_title, year = excluded.year,
       overview = excluded.overview, tagline = excluded.tagline, runtime = excluded.runtime,
       vote_average = excluded.vote_average, genres = excluded.genres, cast_crew = excluded.cast_crew,
       poster_path = excluded.poster_path, backdrop_path = excluded.backdrop_path, logo_path = excluded.logo_path,
       resolution = excluded.resolution, video_codec = excluded.video_codec,
       hdr_format = excluded.hdr_format, audio_codec = excluded.audio_codec`,
    [
      meta.tmdb_id, file.file_path, file.raw_filename, file.file_mtime, meta.title, meta.original_title, meta.year,
      meta.overview, meta.tagline, meta.runtime, meta.vote_average, json(meta.genres), json(meta.cast_crew),
      meta.poster_path, meta.backdrop_path, meta.logo_path,
      tech.resolution, tech.video_codec, tech.hdr_format, tech.audio_codec, meta.imdb_id,
    ],
  );
}

export async function updateMovieMetadata(id: number, meta: MovieMetadata) {
  await exec(
    `UPDATE movies SET tmdb_id=$1, title=$2, original_title=$3, year=$4, overview=$5, tagline=$6, runtime=$7,
       vote_average=$8, genres=$9, cast_crew=$10, poster_path=$11, backdrop_path=$12, logo_path=$13,
       imdb_id=$15, imdb_rating=NULL, imdb_votes=NULL
     WHERE id=$14`,
    [
      meta.tmdb_id, meta.title, meta.original_title, meta.year, meta.overview, meta.tagline, meta.runtime,
      meta.vote_average, json(meta.genres), json(meta.cast_crew), meta.poster_path, meta.backdrop_path,
      meta.logo_path, id, meta.imdb_id,
    ],
  );
}

export interface SeriesMetadata {
  tmdb_id: number;
  title: string;
  year: number | null;
  overview: string | null;
  vote_average: number | null;
  genres: string[];
  cast_crew: unknown[];
  poster_path: string | null;
  backdrop_path: string | null;
  logo_path: string | null;
  number_of_seasons: number;
  imdb_id: string | null;
}

/** Inserts or refreshes a series by TMDB id and returns its local row id. */
export async function upsertSeries(meta: SeriesMetadata, folderPath: string | null): Promise<number> {
  await exec(
    `INSERT INTO tv_series (tmdb_id, folder_path, title, year, overview, vote_average, genres, cast_crew,
       poster_path, backdrop_path, logo_path, number_of_seasons, imdb_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT(tmdb_id) DO UPDATE SET
       imdb_id = COALESCE(excluded.imdb_id, tv_series.imdb_id),
       folder_path = COALESCE(tv_series.folder_path, excluded.folder_path), title = excluded.title,
       year = excluded.year, overview = excluded.overview, vote_average = excluded.vote_average,
       genres = excluded.genres, cast_crew = excluded.cast_crew, poster_path = excluded.poster_path,
       backdrop_path = excluded.backdrop_path, logo_path = excluded.logo_path,
       number_of_seasons = excluded.number_of_seasons`,
    [
      meta.tmdb_id, folderPath, meta.title, meta.year, meta.overview, meta.vote_average, json(meta.genres),
      json(meta.cast_crew), meta.poster_path, meta.backdrop_path, meta.logo_path, meta.number_of_seasons,
      meta.imdb_id,
    ],
  );
  const rows = await select<{ id: number }[]>('SELECT id FROM tv_series WHERE tmdb_id = $1', [meta.tmdb_id]);
  return rows[0].id;
}

export interface EpisodeMetadata {
  tmdb_episode_id: number | null;
  season_number: number;
  episode_number: number;
  title: string;
  overview: string | null;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
}

export async function upsertEpisode(seriesId: number, file: FileInfo, meta: EpisodeMetadata, tech: TechInfo) {
  await exec(
    `INSERT INTO episodes (series_id, tmdb_episode_id, file_path, raw_filename, file_mtime, season_number,
       episode_number, title, overview, still_path, air_date, runtime, resolution, video_codec, hdr_format, audio_codec)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT(file_path) DO UPDATE SET
       series_id = excluded.series_id, tmdb_episode_id = excluded.tmdb_episode_id,
       raw_filename = excluded.raw_filename, file_mtime = excluded.file_mtime,
       season_number = excluded.season_number, episode_number = excluded.episode_number,
       title = excluded.title, overview = excluded.overview, still_path = excluded.still_path,
       air_date = excluded.air_date, runtime = excluded.runtime, resolution = excluded.resolution,
       video_codec = excluded.video_codec, hdr_format = excluded.hdr_format, audio_codec = excluded.audio_codec`,
    [
      seriesId, meta.tmdb_episode_id, file.file_path, file.raw_filename, file.file_mtime, meta.season_number,
      meta.episode_number, meta.title, meta.overview, meta.still_path, meta.air_date, meta.runtime,
      tech.resolution, tech.video_codec, tech.hdr_format, tech.audio_codec,
    ],
  );
}

async function deleteByPaths(table: 'movies' | 'episodes', paths: string[]) {
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(',');
    await exec(`DELETE FROM ${table} WHERE file_path IN (${placeholders})`, chunk);
  }
}

export async function deleteMediaPaths(moviePaths: string[], episodePaths: string[]) {
  await deleteByPaths('movies', moviePaths);
  await deleteByPaths('episodes', episodePaths);
  await pruneEmptySeries();
  await pruneOrphanSubtitles();
}

export async function pruneEmptySeries() {
  await exec('DELETE FROM tv_series WHERE id NOT IN (SELECT DISTINCT series_id FROM episodes)');
}

export async function deleteMovie(id: number) {
  await exec('DELETE FROM movies WHERE id = $1', [id]);
  await pruneOrphanSubtitles();
}

export async function deleteSeries(id: number) {
  await exec('DELETE FROM episodes WHERE series_id = $1', [id]);
  await exec('DELETE FROM tv_series WHERE id = $1', [id]);
  await pruneOrphanSubtitles();
}

export async function moveEpisodes(fromSeriesId: number, toSeriesId: number) {
  await exec('UPDATE episodes SET series_id = $1 WHERE series_id = $2', [toSeriesId, fromSeriesId]);
}

export async function updateSeriesById(id: number, meta: SeriesMetadata) {
  await exec(
    `UPDATE tv_series SET tmdb_id=$1, title=$2, year=$3, overview=$4, vote_average=$5, genres=$6, cast_crew=$7,
       poster_path=$8, backdrop_path=$9, logo_path=$10, number_of_seasons=$11,
       imdb_id=$13, imdb_rating=NULL, imdb_votes=NULL, imdb_season_ratings=NULL WHERE id=$12`,
    [
      meta.tmdb_id, meta.title, meta.year, meta.overview, meta.vote_average, json(meta.genres),
      json(meta.cast_crew), meta.poster_path, meta.backdrop_path, meta.logo_path, meta.number_of_seasons, id,
      meta.imdb_id,
    ],
  );
}

export async function findSeriesIdByTmdb(tmdbId: number): Promise<number | null> {
  const rows = await select<{ id: number }[]>('SELECT id FROM tv_series WHERE tmdb_id = $1', [tmdbId]);
  return rows[0]?.id ?? null;
}

export async function updateEpisodeMetadata(id: number, meta: EpisodeMetadata) {
  await exec(
    `UPDATE episodes SET tmdb_episode_id=$1, season_number=$2, episode_number=$3, title=$4, overview=$5,
       still_path=$6, air_date=$7, runtime=$8, imdb_id=NULL, imdb_rating=NULL, imdb_votes=NULL WHERE id=$9`,
    [
      meta.tmdb_episode_id, meta.season_number, meta.episode_number, meta.title, meta.overview, meta.still_path,
      meta.air_date, meta.runtime, id,
    ],
  );
}

export async function getEpisodesForSeries(seriesId: number) {
  return select<EpisodeRow[]>('SELECT * FROM episodes WHERE series_id = $1', [seriesId]);
}

/** Re-points rows at files that were moved on disk, so progress and matches survive. */
export async function updateFilePaths(moves: { from: string; to: string }[]) {
  for (const { from, to } of moves) {
    await exec('UPDATE movies SET file_path = $2 WHERE file_path = $1', [from, to]);
    await exec('UPDATE episodes SET file_path = $2 WHERE file_path = $1', [from, to]);
    await exec('UPDATE subtitles SET file_path = $2 WHERE file_path = $1', [from, to]);
  }
}

export async function clearLibrary() {
  await exec('DELETE FROM subtitles');
  await exec('DELETE FROM episodes');
  await exec('DELETE FROM tv_series');
  await exec('DELETE FROM movies');
}

// ---------------------------------------------------------------------------
// User state
// ---------------------------------------------------------------------------

export async function setMyList(kind: 'movie' | 'tv', id: number, value: boolean) {
  const table = kind === 'movie' ? 'movies' : 'tv_series';
  await exec(`UPDATE ${table} SET my_list = $1 WHERE id = $2`, [value ? 1 : 0, id]);
}

export const CONTINUE_MIN_SECONDS = 30;
export const COMPLETED_RATIO = 0.9;

export type ProgressOutcome = 'ignored' | 'progress' | 'completed';

/** Applies the watch-state rules (30s minimum / 90% completion) for a movie or episode. */
export async function recordProgress(
  type: 'movie' | 'episode',
  id: number,
  time: number,
  length: number,
): Promise<ProgressOutcome> {
  if (!length || length <= 0) return 'ignored';
  const table = type === 'movie' ? 'movies' : 'episodes';
  const ratio = time / length;
  let outcome: ProgressOutcome = 'ignored';
  if (ratio >= COMPLETED_RATIO) {
    await exec(
      `UPDATE ${table} SET watched = 1, progress_seconds = 0, duration_seconds = $1,
         last_watched_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [Math.round(length), id],
    );
    outcome = 'completed';
  } else if (time > CONTINUE_MIN_SECONDS) {
    await exec(
      `UPDATE ${table} SET watched = 0, progress_seconds = $1, duration_seconds = $2,
         last_watched_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [Math.floor(time), Math.round(length), id],
    );
    outcome = 'progress';
  }
  if (outcome !== 'ignored' && type === 'episode') {
    await exec(
      `UPDATE tv_series SET last_watched_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT series_id FROM episodes WHERE id = $1)`,
      [id],
    );
  }
  return outcome;
}

/**
 * Manually marks a movie/episode watched or unwatched. Watching bumps the series so "Next Up"
 * advances past it; unwatching clears its timestamp so "Next Up" falls back to the prior episode.
 */
export async function setWatched(type: 'movie' | 'episode', id: number, watched: boolean) {
  const table = type === 'movie' ? 'movies' : 'episodes';
  await exec(
    `UPDATE ${table} SET watched = $1, progress_seconds = 0,
       last_watched_at = ${watched ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = $2`,
    [watched ? 1 : 0, id],
  );
  if (watched && type === 'episode') {
    await exec(
      `UPDATE tv_series SET last_watched_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT series_id FROM episodes WHERE id = $1)`,
      [id],
    );
  }
}

/** Removes an item from "Continue Watching" without touching its watched flag. */
export async function clearResume(kind: 'movie' | 'tv', id: number) {
  if (kind === 'movie') {
    await exec('UPDATE movies SET progress_seconds = 0, last_watched_at = NULL WHERE id = $1', [id]);
  } else {
    await exec('UPDATE tv_series SET last_watched_at = NULL WHERE id = $1', [id]);
    await exec('UPDATE episodes SET progress_seconds = 0 WHERE series_id = $1', [id]);
  }
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

export async function listSubtitles(type: PlayableType, id: number) {
  return select<SubtitleRow[]>(
    'SELECT * FROM subtitles WHERE media_type = $1 AND media_id = $2 ORDER BY created_at DESC, id DESC',
    [type, id],
  );
}

export interface NewSubtitle {
  language: string;
  file_path: string;
  source: SubtitleRow['source'];
  release_name: string | null;
  hash_match: boolean;
  opensubtitles_file_id: number | null;
}

/** Records a subtitle file for a movie/episode and returns its row id. */
export async function addSubtitle(type: PlayableType, id: number, sub: NewSubtitle): Promise<number> {
  await exec(
    `INSERT INTO subtitles (media_type, media_id, language, file_path, source, release_name, hash_match, opensubtitles_file_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(media_type, media_id, file_path) DO UPDATE SET
       language = excluded.language, source = excluded.source, release_name = excluded.release_name,
       hash_match = excluded.hash_match, opensubtitles_file_id = excluded.opensubtitles_file_id`,
    [type, id, sub.language, sub.file_path, sub.source, sub.release_name, sub.hash_match ? 1 : 0, sub.opensubtitles_file_id],
  );
  const rows = await select<{ id: number }[]>(
    'SELECT id FROM subtitles WHERE media_type = $1 AND media_id = $2 AND file_path = $3',
    [type, id, sub.file_path],
  );
  return rows[0].id;
}

/** Makes one subtitle the active one for a movie/episode (null = subtitles off). */
export async function selectSubtitle(type: PlayableType, id: number, subtitleId: number | null) {
  await exec(
    'UPDATE subtitles SET selected = CASE WHEN id = $3 THEN 1 ELSE 0 END WHERE media_type = $1 AND media_id = $2',
    [type, id, subtitleId ?? -1],
  );
}

export async function getSelectedSubtitlePath(type: PlayableType, id: number): Promise<string | null> {
  const rows = await select<{ file_path: string }[]>(
    'SELECT file_path FROM subtitles WHERE media_type = $1 AND media_id = $2 AND selected = 1 LIMIT 1',
    [type, id],
  );
  return rows[0]?.file_path ?? null;
}

export async function deleteSubtitle(subtitleId: number) {
  await exec('DELETE FROM subtitles WHERE id = $1', [subtitleId]);
}

// ---------------------------------------------------------------------------
// IMDb
// ---------------------------------------------------------------------------

/** Stores an IMDb id resolved via TMDB ('' = TMDB has none, so we don't ask again). */
export async function setImdbId(table: 'movies' | 'tv_series', tmdbId: number, imdbId: string) {
  await exec(`UPDATE ${table} SET imdb_id = $2 WHERE tmdb_id = $1`, [tmdbId, imdbId]);
}

export async function setTitleImdbRating(table: 'movies' | 'tv_series', imdbId: string, rating: number | null, votes: number | null) {
  await exec(`UPDATE ${table} SET imdb_rating = $2, imdb_votes = $3 WHERE imdb_id = $1`, [imdbId, rating, votes]);
}

export async function setSeasonRatings(seriesId: number, ratings: Record<number, { rating: number; count: number }>) {
  await exec('UPDATE tv_series SET imdb_season_ratings = $2 WHERE id = $1', [seriesId, JSON.stringify(ratings)]);
}

export async function setEpisodeImdb(id: number, imdbId: string | null, rating: number | null, votes: number | null) {
  await exec('UPDATE episodes SET imdb_id = $2, imdb_rating = $3, imdb_votes = $4 WHERE id = $1', [id, imdbId, rating, votes]);
}

// ---------------------------------------------------------------------------
// Recently Deleted
// ---------------------------------------------------------------------------

export async function listTrash() {
  return select<TrashRow[]>('SELECT * FROM trash ORDER BY deleted_at DESC, id DESC');
}

export async function addTrash(entry: Omit<TrashRow, 'id' | 'deleted_at'>) {
  await exec(
    'INSERT INTO trash (label, kind, poster_path, entry_dir, items, snapshot, size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [entry.label, entry.kind, entry.poster_path, entry.entry_dir, entry.items, entry.snapshot, entry.size_bytes],
  );
}

export async function deleteTrashRow(id: number) {
  await exec('DELETE FROM trash WHERE id = $1', [id]);
}

export async function snapshotFor(movieIds: number[], episodeIds: number[], seriesId: number | null): Promise<TrashSnapshot> {
  const inList = (ids: number[]) => (ids.length ? ids.join(',') : '-1'); // ids are integers from our own rows
  const [movies, episodes, series, subs] = await Promise.all([
    select<MovieRow[]>(`SELECT * FROM movies WHERE id IN (${inList(movieIds)})`),
    select<EpisodeRow[]>(`SELECT * FROM episodes WHERE id IN (${inList(episodeIds)})`),
    seriesId != null ? select<SeriesRow[]>('SELECT * FROM tv_series WHERE id = $1', [seriesId]) : Promise.resolve([]),
    select<SubtitleRow[]>(
      `SELECT * FROM subtitles WHERE (media_type = 'movie' AND media_id IN (${inList(movieIds)}))
         OR (media_type = 'episode' AND media_id IN (${inList(episodeIds)}))`,
    ),
  ]);
  return { movies, episodes, series: series[0] ?? null, subtitles: subs };
}

export async function removeLibraryRows(movieIds: number[], episodeIds: number[]) {
  for (const id of movieIds) await exec('DELETE FROM movies WHERE id = $1', [id]);
  for (const id of episodeIds) await exec('DELETE FROM episodes WHERE id = $1', [id]);
  await pruneEmptySeries();
  await pruneOrphanSubtitles();
}

async function insertRow(table: string, row: object): Promise<void> {
  const entries = Object.entries(row).filter(([k]) => k !== 'id');
  const cols = entries.map(([k]) => k).join(', ');
  const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
  await exec(`INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${placeholders})`, entries.map(([, v]) => v));
}

/** Re-inserts deleted rows (with their watch progress, My List flag and TMDB match). */
export async function restoreSnapshot(snap: TrashSnapshot) {
  const movieIds = new Map<number, number>();
  const episodeIds = new Map<number, number>();
  for (const m of snap.movies) {
    await insertRow('movies', m);
    const rows = await select<{ id: number }[]>('SELECT id FROM movies WHERE file_path = $1', [m.file_path]);
    if (rows[0]) movieIds.set(m.id, rows[0].id);
  }
  if (snap.series && snap.episodes.length) {
    let seriesId = await findSeriesIdByTmdb(snap.series.tmdb_id);
    if (seriesId == null) {
      await insertRow('tv_series', snap.series);
      seriesId = await findSeriesIdByTmdb(snap.series.tmdb_id);
    }
    for (const e of snap.episodes) {
      await insertRow('episodes', { ...e, series_id: seriesId });
      const rows = await select<{ id: number }[]>('SELECT id FROM episodes WHERE file_path = $1', [e.file_path]);
      if (rows[0]) episodeIds.set(e.id, rows[0].id);
    }
  }
  for (const s of snap.subtitles) {
    const newId = (s.media_type === 'movie' ? movieIds : episodeIds).get(s.media_id);
    if (newId != null) await insertRow('subtitles', { ...s, media_id: newId });
  }
}

export async function pruneOrphanSubtitles() {
  await exec("DELETE FROM subtitles WHERE media_type = 'movie' AND media_id NOT IN (SELECT id FROM movies)");
  await exec("DELETE FROM subtitles WHERE media_type = 'episode' AND media_id NOT IN (SELECT id FROM episodes)");
}
