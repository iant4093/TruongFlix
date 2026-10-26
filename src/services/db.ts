import Database from '@tauri-apps/plugin-sql';
import type {
  CollectionPart,
  CollectionRow,
  EpisodeRow,
  MediaInfo,
  MovieRow,
  NextEpisode,
  PlayableType,
  Profile,
  ProfileInput,
  SeasonEpisodeInfo,
  Segment,
  SeriesRow,
  Settings,
  ShareInfo,
  SubtitleRow,
  SubtitleStyle,
  TechInfo,
  TrashRow,
  TrashSnapshot,
  WatchLogRow,
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
  `CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    maturity TEXT NOT NULL DEFAULT 'all',  -- 'kids' | 'teen' | 'all'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // Per-profile watch state; the matching columns on movies/episodes/tv_series are legacy.
  `CREATE TABLE IF NOT EXISTS profile_state (
    profile_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,              -- 'movie' | 'episode' | 'tv'
    media_id INTEGER NOT NULL,
    progress_seconds INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    watched INTEGER DEFAULT 0,
    my_list INTEGER DEFAULT 0,
    last_watched_at DATETIME,
    PRIMARY KEY (profile_id, media_type, media_id)
  )`,
  // Seconds watched per title per day (Wrapped + Viewing Activity). Titles are copied in so
  // history survives deleting the files.
  `CREATE TABLE IF NOT EXISTS watch_log (
    profile_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    media_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    seconds REAL NOT NULL DEFAULT 0,
    title TEXT,
    series_id INTEGER,
    series_title TEXT,
    genres TEXT,
    season_number INTEGER,
    episode_number INTEGER,
    poster TEXT,
    PRIMARY KEY (profile_id, media_type, media_id, day)
  )`,
  `CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,                -- TMDB collection id
    name TEXT,
    overview TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    parts TEXT,                            -- JSON CollectionPart[] in release order
    fetched_at DATETIME
  )`,
  `CREATE TABLE IF NOT EXISTS season_cache (
    series_tmdb_id INTEGER NOT NULL,
    season_number INTEGER NOT NULL,
    episodes TEXT NOT NULL,                -- JSON SeasonEpisodeInfo[]
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series_tmdb_id, season_number)
  )`,
  `CREATE TABLE IF NOT EXISTS rename_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    label TEXT,
    moves TEXT NOT NULL,                   -- JSON FileMove[] actually applied
    roots TEXT NOT NULL,
    undone INTEGER DEFAULT 0
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
    ['certification', 'TEXT'], // NULL = not fetched yet, '' = none
    ['collection_id', 'INTEGER'], // NULL = not fetched yet, 0 = not part of a collection
    ['collection_name', 'TEXT'],
    ['trailer_key', 'TEXT'], // YouTube key; '' = none
    ['file_size', 'INTEGER'],
    ['media_info', 'TEXT'], // JSON MediaInfo from media_probe
    ['segments', 'TEXT'], // JSON Segment[] (intro/recap/credits)
    ['probed_mtime', 'INTEGER'], // file_mtime when media_info was read
    ['enriched_at', 'DATETIME'], // TMDB extras (rating, collection, trailer) fetched
    ['probe_error', 'TEXT'], // file exists but couldn't be opened/decoded
    ['rt_score', 'INTEGER'], // Rotten Tomatoes critics %, from OMDb
    ['metacritic', 'INTEGER'],
    ['omdb_at', 'DATETIME'],
  ],
  tv_series: [
    ['imdb_id', 'TEXT'],
    ['imdb_rating', 'REAL'],
    ['imdb_votes', 'INTEGER'],
    ['imdb_season_ratings', 'TEXT'], // JSON {"1": {"rating": 8.4, "count": 9}}
    ['rt_score', 'INTEGER'],
    ['metacritic', 'INTEGER'],
    ['omdb_at', 'DATETIME'],
    ['certification', 'TEXT'],
    ['trailer_key', 'TEXT'],
    ['tmdb_status', 'TEXT'],
    ['next_episode', 'TEXT'], // JSON NextEpisode
    ['enriched_at', 'DATETIME'],
  ],
  episodes: [
    ['imdb_id', 'TEXT'],
    ['imdb_rating', 'REAL'],
    ['imdb_votes', 'INTEGER'],
    ['file_size', 'INTEGER'],
    ['media_info', 'TEXT'],
    ['segments', 'TEXT'],
    ['probed_mtime', 'INTEGER'],
    ['intro_checked', 'INTEGER'], // audio intro detection done
    ['probe_error', 'TEXT'],
  ],
};

// Profile limits (added after profiles shipped).
ADDED_COLUMNS.profiles = [
  ['daily_limit', 'INTEGER NOT NULL DEFAULT 0'],
  ['bedtime', "TEXT NOT NULL DEFAULT ''"],
  ['wake_time', "TEXT NOT NULL DEFAULT '07:00'"],
  ['pin', "TEXT NOT NULL DEFAULT ''"],
];

const PROFILE_COLORS = ['#E50914', '#2E86DE', '#F5B70A', '#1ABC9C', '#8E44AD', '#E67E22'];

async function migrate(db: Database) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set((await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`)).map((c) => c.name));
    for (const [name, type] of columns) {
      if (!existing.has(name)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  await db.execute('CREATE INDEX IF NOT EXISTS idx_movies_imdb ON movies(imdb_id)');

  // First run with profiles: create the default profile and move existing watch state into it.
  const profiles = await db.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM profiles');
  if (!profiles[0]?.n) {
    await db.execute('INSERT INTO profiles (name, color, maturity) VALUES ($1, $2, $3)', ['You', PROFILE_COLORS[0], 'all']);
    const [{ id }] = await db.select<{ id: number }[]>('SELECT id FROM profiles ORDER BY id LIMIT 1');
    await db.execute(
      `INSERT OR IGNORE INTO profile_state (profile_id, media_type, media_id, progress_seconds, duration_seconds, watched, my_list, last_watched_at)
       SELECT $1, 'movie', id, progress_seconds, duration_seconds, watched, my_list, last_watched_at FROM movies
       WHERE progress_seconds > 0 OR watched = 1 OR my_list = 1 OR last_watched_at IS NOT NULL`,
      [id],
    );
    await db.execute(
      `INSERT OR IGNORE INTO profile_state (profile_id, media_type, media_id, progress_seconds, duration_seconds, watched, last_watched_at)
       SELECT $1, 'episode', id, progress_seconds, duration_seconds, watched, last_watched_at FROM episodes
       WHERE progress_seconds > 0 OR watched = 1 OR last_watched_at IS NOT NULL`,
      [id],
    );
    await db.execute(
      `INSERT OR IGNORE INTO profile_state (profile_id, media_type, media_id, my_list, last_watched_at)
       SELECT $1, 'tv', id, my_list, last_watched_at FROM tv_series WHERE my_list = 1 OR last_watched_at IS NOT NULL`,
      [id],
    );
  }
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
    subtitle_style: parseStyle(map.subtitle_style),
    audio_night: map.audio_night === 'true',
    audio_dialogue: map.audio_dialogue === 'true',
    intro_detection: map.intro_detection !== 'false',
    skip_intro_auto: map.skip_intro_auto === 'true',
    watch_folders: map.watch_folders !== 'false',
    trailers_autoplay: map.trailers_autoplay !== 'false',
    launch_intro: map.launch_intro !== 'false',
    launch_intro_sound: map.launch_intro_sound !== 'false',
    hover_stills: map.hover_stills !== 'false',
    ask_profile: map.ask_profile !== 'false',
    active_profile: Number(map.active_profile) || 0,
    still_watching_after: map.still_watching_after != null ? Number(map.still_watching_after) : 3,
    audio_device: map.audio_device || 'auto',
    audio_passthrough: map.audio_passthrough === 'true',
    audio_delays: parseObject<Record<string, number>>(map.audio_delays),
    pause_on_lock: map.pause_on_lock !== 'false',
    omdb_api_key: map.omdb_api_key ?? '',
    network_shares: parseObject<Record<string, ShareInfo>>(map.network_shares),
  };
}

const DEFAULT_STYLE: SubtitleStyle = { size: 'medium', color: 'white', background: 'shadow', font: 'sans' };

function parseObject<T extends object>(raw: string | undefined): T {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return (v && typeof v === 'object' ? v : {}) as T;
  } catch {
    return {} as T;
  }
}

function parseStyle(raw: string | undefined): SubtitleStyle {
  try {
    return { ...DEFAULT_STYLE, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULT_STYLE;
  }
}

export async function saveSetting(key: keyof Settings, value: string | string[] | boolean | number | object) {
  const stored = typeof value === 'object' ? JSON.stringify(value) : String(value);
  await exec(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, stored],
  );
}

// ---------------------------------------------------------------------------
// Library reads
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

let activeProfile = 1;

export function setActiveProfile(id: number) {
  activeProfile = id;
}
export const getActiveProfile = () => activeProfile;

export async function listProfiles() {
  return select<Profile[]>('SELECT * FROM profiles ORDER BY id');
}

export async function createProfile(p: ProfileInput): Promise<number> {
  const res = await exec('INSERT INTO profiles (name, color, maturity, daily_limit, bedtime, wake_time, pin) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    p.name, p.color, p.maturity, p.daily_limit, p.bedtime, p.wake_time, p.pin,
  ]);
  return res.lastInsertId ?? (await select<{ id: number }[]>('SELECT MAX(id) AS id FROM profiles'))[0].id;
}

export async function updateProfile(id: number, p: ProfileInput) {
  await exec('UPDATE profiles SET name = $2, color = $3, maturity = $4, daily_limit = $5, bedtime = $6, wake_time = $7, pin = $8 WHERE id = $1', [
    id, p.name, p.color, p.maturity, p.daily_limit, p.bedtime, p.wake_time, p.pin,
  ]);
}

/** Seconds this profile watched today (local date). */
export async function secondsWatchedToday(profileId = activeProfile): Promise<number> {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rows = await select<{ total: number | null }[]>('SELECT SUM(seconds) AS total FROM watch_log WHERE profile_id = $1 AND day = $2', [profileId, day]);
  return rows[0]?.total ?? 0;
}

export async function saveOmdbRatings(table: 'movies' | 'tv_series', imdbId: string, rt: number | null, metacritic: number | null) {
  await exec(`UPDATE ${table} SET rt_score = $2, metacritic = $3, omdb_at = CURRENT_TIMESTAMP WHERE imdb_id = $1`, [imdbId, rt, metacritic]);
}

export async function deleteProfile(id: number) {
  await exec('DELETE FROM profile_state WHERE profile_id = $1', [id]);
  await exec('DELETE FROM watch_log WHERE profile_id = $1', [id]);
  await exec('DELETE FROM profiles WHERE id = $1', [id]);
}

export const nextProfileColor = (used: string[]) => PROFILE_COLORS.find((c) => !used.includes(c)) ?? PROFILE_COLORS[used.length % PROFILE_COLORS.length];
export const PROFILE_PALETTE = PROFILE_COLORS;

// ---------------------------------------------------------------------------
// Library reads
// ---------------------------------------------------------------------------

interface StateCols {
  ps_progress: number | null;
  ps_duration: number | null;
  ps_watched: number | null;
  ps_my_list: number | null;
  ps_last: string | null;
}

const STATE_SELECT = `ps.progress_seconds AS ps_progress, ps.duration_seconds AS ps_duration, ps.watched AS ps_watched,
  ps.my_list AS ps_my_list, ps.last_watched_at AS ps_last`;

/** Overlays the active profile's watch state onto the row (legacy columns are ignored). */
function withState<T extends object>(row: T & StateCols, media_duration?: number | null) {
  const { ps_progress, ps_duration, ps_watched, ps_my_list, ps_last, ...rest } = row;
  return {
    ...rest,
    progress_seconds: ps_progress ?? 0,
    duration_seconds: ps_duration || media_duration || 0,
    watched: ps_watched ?? 0,
    my_list: ps_my_list ?? 0,
    last_watched_at: ps_last ?? null,
  } as unknown as T;
}

const mediaDuration = (json: string | null) => {
  if (!json) return null;
  try {
    return Math.round((JSON.parse(json) as MediaInfo).duration) || null;
  } catch {
    return null;
  }
};

export async function loadLibrary() {
  const p = activeProfile;
  const [movies, series, episodes] = await Promise.all([
    select<(MovieRow & StateCols)[]>(
      `SELECT m.*, ${STATE_SELECT} FROM movies m
       LEFT JOIN profile_state ps ON ps.profile_id = $1 AND ps.media_type = 'movie' AND ps.media_id = m.id`,
      [p],
    ),
    select<(SeriesRow & StateCols)[]>(
      `SELECT s.*, ${STATE_SELECT} FROM tv_series s
       LEFT JOIN profile_state ps ON ps.profile_id = $1 AND ps.media_type = 'tv' AND ps.media_id = s.id`,
      [p],
    ),
    select<(EpisodeRow & StateCols)[]>(
      `SELECT e.*, ${STATE_SELECT} FROM episodes e
       LEFT JOIN profile_state ps ON ps.profile_id = $1 AND ps.media_type = 'episode' AND ps.media_id = e.id
       ORDER BY e.series_id, e.season_number, e.episode_number`,
      [p],
    ),
  ]);
  return {
    movies: movies.map((m) => withState<MovieRow>(m, mediaDuration(m.media_info))),
    series: series.map((s) => withState<SeriesRow>(s)),
    episodes: episodes.map((e) => withState<EpisodeRow>(e, mediaDuration(e.media_info))),
  };
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
  /** Age rating, collection and trailer (fetched with the details; null when unknown). */
  extras?: MovieExtras | null;
}

export interface MovieExtras {
  certification: string;
  collection_id: number;
  collection_name: string | null;
  trailer_key: string;
}

export interface SeriesExtras {
  certification: string;
  trailer_key: string;
  tmdb_status: string | null;
  next_episode: NextEpisode | null;
}

export interface FileInfo {
  file_path: string;
  raw_filename: string;
  file_mtime: number;
  file_size?: number | null;
}

export async function upsertMovie(file: FileInfo, meta: MovieMetadata, tech: TechInfo) {
  await exec(
    `INSERT INTO movies (tmdb_id, file_path, raw_filename, file_mtime, title, original_title, year, overview, tagline,
       runtime, vote_average, genres, cast_crew, poster_path, backdrop_path, logo_path,
       resolution, video_codec, hdr_format, audio_codec, imdb_id, file_size,
       certification, collection_id, collection_name, trailer_key, enriched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
       CASE WHEN $23 IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)
     ON CONFLICT(file_path) DO UPDATE SET
       file_size = excluded.file_size, certification = excluded.certification,
       collection_id = excluded.collection_id, collection_name = excluded.collection_name,
       trailer_key = excluded.trailer_key, enriched_at = excluded.enriched_at,
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
      tech.resolution, tech.video_codec, tech.hdr_format, tech.audio_codec, meta.imdb_id, file.file_size ?? null,
      meta.extras?.certification ?? null, meta.extras?.collection_id ?? null, meta.extras?.collection_name ?? null,
      meta.extras?.trailer_key ?? null,
    ],
  );
}

export async function updateMovieMetadata(id: number, meta: MovieMetadata) {
  await exec(
    `UPDATE movies SET tmdb_id=$1, title=$2, original_title=$3, year=$4, overview=$5, tagline=$6, runtime=$7,
       vote_average=$8, genres=$9, cast_crew=$10, poster_path=$11, backdrop_path=$12, logo_path=$13,
       imdb_id=$15, imdb_rating=NULL, imdb_votes=NULL, certification=$16, collection_id=$17, collection_name=$18,
       trailer_key=$19, enriched_at=CASE WHEN $16 IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
     WHERE id=$14`,
    [
      meta.tmdb_id, meta.title, meta.original_title, meta.year, meta.overview, meta.tagline, meta.runtime,
      meta.vote_average, json(meta.genres), json(meta.cast_crew), meta.poster_path, meta.backdrop_path,
      meta.logo_path, id, meta.imdb_id, meta.extras?.certification ?? null, meta.extras?.collection_id ?? null,
      meta.extras?.collection_name ?? null, meta.extras?.trailer_key ?? null,
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
  extras?: SeriesExtras | null;
}

/** Inserts or refreshes a series by TMDB id and returns its local row id. */
export async function upsertSeries(meta: SeriesMetadata, folderPath: string | null): Promise<number> {
  await exec(
    `INSERT INTO tv_series (tmdb_id, folder_path, title, year, overview, vote_average, genres, cast_crew,
       poster_path, backdrop_path, logo_path, number_of_seasons, imdb_id,
       certification, trailer_key, tmdb_status, next_episode, enriched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       CASE WHEN $14 IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)
     ON CONFLICT(tmdb_id) DO UPDATE SET
       certification = COALESCE(excluded.certification, tv_series.certification),
       trailer_key = COALESCE(excluded.trailer_key, tv_series.trailer_key),
       tmdb_status = COALESCE(excluded.tmdb_status, tv_series.tmdb_status),
       next_episode = CASE WHEN excluded.enriched_at IS NULL THEN tv_series.next_episode ELSE excluded.next_episode END,
       enriched_at = COALESCE(excluded.enriched_at, tv_series.enriched_at),
       imdb_id = COALESCE(excluded.imdb_id, tv_series.imdb_id),
       folder_path = COALESCE(tv_series.folder_path, excluded.folder_path), title = excluded.title,
       year = excluded.year, overview = excluded.overview, vote_average = excluded.vote_average,
       genres = excluded.genres, cast_crew = excluded.cast_crew, poster_path = excluded.poster_path,
       backdrop_path = excluded.backdrop_path, logo_path = excluded.logo_path,
       number_of_seasons = excluded.number_of_seasons`,
    [
      meta.tmdb_id, folderPath, meta.title, meta.year, meta.overview, meta.vote_average, json(meta.genres),
      json(meta.cast_crew), meta.poster_path, meta.backdrop_path, meta.logo_path, meta.number_of_seasons,
      meta.imdb_id, meta.extras?.certification ?? null, meta.extras?.trailer_key ?? null,
      meta.extras?.tmdb_status ?? null, json(meta.extras?.next_episode ?? null),
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
       episode_number, title, overview, still_path, air_date, runtime, resolution, video_codec, hdr_format, audio_codec, file_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT(file_path) DO UPDATE SET
       series_id = excluded.series_id, tmdb_episode_id = excluded.tmdb_episode_id,
       raw_filename = excluded.raw_filename, file_mtime = excluded.file_mtime,
       season_number = excluded.season_number, episode_number = excluded.episode_number,
       title = excluded.title, overview = excluded.overview, still_path = excluded.still_path,
       air_date = excluded.air_date, runtime = excluded.runtime, resolution = excluded.resolution,
       video_codec = excluded.video_codec, hdr_format = excluded.hdr_format, audio_codec = excluded.audio_codec,
       file_size = excluded.file_size,
       intro_checked = CASE WHEN episodes.file_mtime = excluded.file_mtime THEN episodes.intro_checked END`,
    [
      seriesId, meta.tmdb_episode_id, file.file_path, file.raw_filename, file.file_mtime, meta.season_number,
      meta.episode_number, meta.title, meta.overview, meta.still_path, meta.air_date, meta.runtime,
      tech.resolution, tech.video_codec, tech.hdr_format, tech.audio_codec, file.file_size ?? null,
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
  await pruneOrphanState();
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

/** Upserts the active profile's state for one item. Only the given fields change. */
async function upsertState(
  mediaType: 'movie' | 'episode' | 'tv',
  id: number,
  fields: Partial<{ progress_seconds: number; duration_seconds: number; watched: number; my_list: number; last_watched_at: 'now' | null }>,
) {
  const cols = Object.keys(fields);
  const values = cols.map((c) => (fields as Record<string, unknown>)[c]);
  const valueSql = cols.map((c, i) => (c === 'last_watched_at' && values[i] === 'now' ? 'CURRENT_TIMESTAMP' : `$${i + 4}`));
  const params = [activeProfile, mediaType, id, ...values.map((v) => (v === 'now' ? null : v))];
  await exec(
    `INSERT INTO profile_state (profile_id, media_type, media_id, ${cols.join(', ')})
     VALUES ($1, $2, $3, ${valueSql.join(', ')})
     ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET ${cols.map((c, i) => `${c} = ${valueSql[i]}`).join(', ')}`,
    params,
  );
}

async function seriesOf(episodeId: number): Promise<number | null> {
  const rows = await select<{ series_id: number }[]>('SELECT series_id FROM episodes WHERE id = $1', [episodeId]);
  return rows[0]?.series_id ?? null;
}

export async function setMyList(kind: 'movie' | 'tv', id: number, value: boolean) {
  await upsertState(kind, id, { my_list: value ? 1 : 0 });
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
  const ratio = time / length;
  let outcome: ProgressOutcome = 'ignored';
  if (ratio >= COMPLETED_RATIO) {
    await upsertState(type, id, { watched: 1, progress_seconds: 0, duration_seconds: Math.round(length), last_watched_at: 'now' });
    outcome = 'completed';
  } else if (time > CONTINUE_MIN_SECONDS) {
    await upsertState(type, id, { watched: 0, progress_seconds: Math.floor(time), duration_seconds: Math.round(length), last_watched_at: 'now' });
    outcome = 'progress';
  }
  if (outcome !== 'ignored' && type === 'episode') {
    const series = await seriesOf(id);
    if (series != null) await upsertState('tv', series, { last_watched_at: 'now' });
  }
  return outcome;
}

/**
 * Manually marks a movie/episode watched or unwatched. Watching bumps the series so "Next Up"
 * advances past it; unwatching clears its timestamp so "Next Up" falls back to the prior episode.
 */
export async function setWatched(type: 'movie' | 'episode', id: number, watched: boolean) {
  await upsertState(type, id, { watched: watched ? 1 : 0, progress_seconds: 0, last_watched_at: watched ? 'now' : null });
  if (watched && type === 'episode') {
    const series = await seriesOf(id);
    if (series != null) await upsertState('tv', series, { last_watched_at: 'now' });
  }
}

/** Removes an item from "Continue Watching" without touching its watched flag. */
export async function clearResume(kind: 'movie' | 'tv', id: number) {
  if (kind === 'movie') {
    await upsertState('movie', id, { progress_seconds: 0, last_watched_at: null });
  } else {
    await upsertState('tv', id, { last_watched_at: null });
    await exec(
      `UPDATE profile_state SET progress_seconds = 0 WHERE profile_id = $1 AND media_type = 'episode'
       AND media_id IN (SELECT id FROM episodes WHERE series_id = $2)`,
      [activeProfile, id],
    );
  }
}

/** Adds naturally-watched seconds to today's Viewing Activity / Wrapped log. */
export async function logWatchTime(
  type: 'movie' | 'episode',
  id: number,
  seconds: number,
  meta: { title: string; series_id: number | null; series_title: string | null; genres: string[]; season: number | null; episode: number | null; poster: string | null },
) {
  if (!(seconds > 0)) return;
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await exec(
    `INSERT INTO watch_log (profile_id, media_type, media_id, day, seconds, title, series_id, series_title, genres,
       season_number, episode_number, poster)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(profile_id, media_type, media_id, day) DO UPDATE SET seconds = watch_log.seconds + excluded.seconds,
       title = excluded.title, series_title = excluded.series_title, genres = excluded.genres, poster = excluded.poster`,
    [activeProfile, type, id, day, seconds, meta.title, meta.series_id, meta.series_title, json(meta.genres), meta.season, meta.episode, meta.poster],
  );
}

export async function listWatchLog(profileId = activeProfile) {
  return select<WatchLogRow[]>('SELECT * FROM watch_log WHERE profile_id = $1 ORDER BY day DESC', [profileId]);
}

export async function deleteWatchLogEntry(type: 'movie' | 'episode', id: number, day: string) {
  await exec('DELETE FROM watch_log WHERE profile_id = $1 AND media_type = $2 AND media_id = $3 AND day = $4', [activeProfile, type, id, day]);
}

// ---------------------------------------------------------------------------
// Media analysis, TMDB extras, collections, season cache, renames
// ---------------------------------------------------------------------------

export async function saveMediaInfo(table: 'movies' | 'episodes', id: number, mtime: number, info: MediaInfo, tech: TechInfo, segments: Segment[]) {
  await exec(
    `UPDATE ${table} SET media_info = $2, probed_mtime = $3, resolution = $4, video_codec = $5, hdr_format = $6,
       audio_codec = $7, segments = $8, file_size = COALESCE($9, file_size), probe_error = NULL WHERE id = $1`,
    [id, JSON.stringify(info), mtime, tech.resolution, tech.video_codec, tech.hdr_format, tech.audio_codec, JSON.stringify(segments), info.size ?? null],
  );
}

export async function markProbeFailed(table: 'movies' | 'episodes', id: number, mtime: number, error: string, size: number | null) {
  await exec(`UPDATE ${table} SET probed_mtime = $2, probe_error = $3, media_info = NULL, file_size = COALESCE($4, file_size) WHERE id = $1`, [
    id,
    mtime,
    error,
    size,
  ]);
}

export async function saveSegments(id: number, segments: Segment[]) {
  await exec('UPDATE episodes SET segments = $2, intro_checked = 1 WHERE id = $1', [id, JSON.stringify(segments)]);
}

export async function markIntroChecked(ids: number[]) {
  for (const id of ids) await exec('UPDATE episodes SET intro_checked = 1 WHERE id = $1', [id]);
}

export async function saveMovieExtras(tmdbId: number, x: MovieExtras) {
  await exec(
    `UPDATE movies SET certification = $2, collection_id = $3, collection_name = $4, trailer_key = $5,
       enriched_at = CURRENT_TIMESTAMP WHERE tmdb_id = $1`,
    [tmdbId, x.certification, x.collection_id, x.collection_name, x.trailer_key],
  );
}

export async function saveSeriesExtras(id: number, x: SeriesExtras) {
  await exec(
    `UPDATE tv_series SET certification = $2, trailer_key = $3, tmdb_status = $4, next_episode = $5,
       enriched_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, x.certification, x.trailer_key, x.tmdb_status, json(x.next_episode)],
  );
}

export async function listCollections() {
  return select<CollectionRow[]>('SELECT * FROM collections');
}

export async function saveCollection(c: { id: number; name: string; overview: string | null; poster_path: string | null; backdrop_path: string | null; parts: CollectionPart[] }) {
  await exec(
    `INSERT INTO collections (id, name, overview, poster_path, backdrop_path, parts, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, overview = excluded.overview, poster_path = excluded.poster_path,
       backdrop_path = excluded.backdrop_path, parts = excluded.parts, fetched_at = excluded.fetched_at`,
    [c.id, c.name, c.overview, c.poster_path, c.backdrop_path, JSON.stringify(c.parts)],
  );
}

export async function getSeasonCache(seriesTmdbId: number) {
  return select<{ season_number: number; episodes: string; fetched_at: string }[]>(
    'SELECT season_number, episodes, fetched_at FROM season_cache WHERE series_tmdb_id = $1',
    [seriesTmdbId],
  );
}

export async function saveSeasonCache(seriesTmdbId: number, season: number, episodes: SeasonEpisodeInfo[]) {
  await exec(
    `INSERT INTO season_cache (series_tmdb_id, season_number, episodes, fetched_at) VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
     ON CONFLICT(series_tmdb_id, season_number) DO UPDATE SET episodes = excluded.episodes, fetched_at = excluded.fetched_at`,
    [seriesTmdbId, season, JSON.stringify(episodes)],
  );
}

export interface RenameBatch {
  id: number;
  created_at: string;
  label: string | null;
  moves: string;
  roots: string;
  undone: number;
}

export async function saveRenameBatch(label: string, moves: { from: string; to: string }[], roots: string[]) {
  await exec('INSERT INTO rename_batches (label, moves, roots) VALUES ($1, $2, $3)', [label, JSON.stringify(moves), JSON.stringify(roots)]);
}

export async function listRenameBatches() {
  return select<RenameBatch[]>('SELECT * FROM rename_batches ORDER BY id DESC LIMIT 20');
}

export async function markRenameUndone(id: number) {
  await exec('UPDATE rename_batches SET undone = 1 WHERE id = $1', [id]);
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
  const state = await select<ProfileStateRow[]>(
    `SELECT * FROM profile_state WHERE (media_type = 'movie' AND media_id IN (${inList(movieIds)}))
       OR (media_type = 'episode' AND media_id IN (${inList(episodeIds)}))
       OR (media_type = 'tv' AND media_id = $1)`,
    [seriesId ?? -1],
  );
  return { movies, episodes, series: series[0] ?? null, subtitles: subs, state };
}

interface ProfileStateRow {
  profile_id: number;
  media_type: string;
  media_id: number;
  progress_seconds: number;
  duration_seconds: number;
  watched: number;
  my_list: number;
  last_watched_at: string | null;
}

export async function removeLibraryRows(movieIds: number[], episodeIds: number[]) {
  for (const id of movieIds) await exec('DELETE FROM movies WHERE id = $1', [id]);
  for (const id of episodeIds) await exec('DELETE FROM episodes WHERE id = $1', [id]);
  await pruneEmptySeries();
  await pruneOrphanSubtitles();
  await pruneOrphanState();
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
  // Every profile's progress / My List for the restored rows (row ids change on restore).
  const newSeriesId = snap.series ? await findSeriesIdByTmdb(snap.series.tmdb_id) : null;
  for (const st of (snap.state ?? []) as ProfileStateRow[]) {
    const newId =
      st.media_type === 'movie' ? movieIds.get(st.media_id) : st.media_type === 'episode' ? episodeIds.get(st.media_id) : newSeriesId;
    if (newId == null) continue;
    await exec(
      `INSERT INTO profile_state (profile_id, media_type, media_id, progress_seconds, duration_seconds, watched, my_list, last_watched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET progress_seconds = excluded.progress_seconds,
         duration_seconds = excluded.duration_seconds, watched = excluded.watched,
         my_list = MAX(profile_state.my_list, excluded.my_list), last_watched_at = excluded.last_watched_at`,
      [st.profile_id, st.media_type, newId, st.progress_seconds, st.duration_seconds, st.watched, st.my_list, st.last_watched_at],
    );
  }
}

export async function pruneOrphanState() {
  await exec("DELETE FROM profile_state WHERE media_type = 'movie' AND media_id NOT IN (SELECT id FROM movies)");
  await exec("DELETE FROM profile_state WHERE media_type = 'episode' AND media_id NOT IN (SELECT id FROM episodes)");
  await exec("DELETE FROM profile_state WHERE media_type = 'tv' AND media_id NOT IN (SELECT id FROM tv_series)");
}

export async function pruneOrphanSubtitles() {
  await exec("DELETE FROM subtitles WHERE media_type = 'movie' AND media_id NOT IN (SELECT id FROM movies)");
  await exec("DELETE FROM subtitles WHERE media_type = 'episode' AND media_id NOT IN (SELECT id FROM episodes)");
}
