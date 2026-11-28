import { getDb } from '../services/db';
import { belongsTo, gameKey, statsFor, type StatSession } from './stats';
import type { GameDetail, GameSettings, GameStatus, InstallChoices, LibraryGame } from './types';

const SCHEMA = `CREATE TABLE IF NOT EXISTS games_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  cover TEXT,
  detail TEXT,                       -- JSON GameDetail
  status TEXT NOT NULL,
  info_hash TEXT,
  installer_dir TEXT,
  install_dir TEXT,
  exe_path TEXT,
  auto_install INTEGER NOT NULL DEFAULT 1,
  delete_installer INTEGER NOT NULL DEFAULT 1,
  choices TEXT,                      -- JSON InstallChoices
  error TEXT,
  size_bytes INTEGER,
  play_seconds INTEGER NOT NULL DEFAULT 0,
  last_played TEXT,
  installed_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

/** One play session, kept even after the game leaves the library so yearly totals stay right. */
const SESSIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS games_play_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  cover TEXT,
  started_at TEXT NOT NULL,          -- ISO time the session started
  seconds INTEGER NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0, -- 1 = rebuilt from a game's total play time
  profile_id INTEGER,                -- profile that started the game (NULL: recorded before profiles were noted)
  game_key TEXT                      -- the game's normalised title (stats.gameKey): same game across installs
)`;

type SqlDb = {
  select<T>(query: string, values?: unknown[]): Promise<T>;
  execute(query: string, values?: unknown[]): Promise<unknown>;
};

/**
 * Creates the library tables. The sessions table was added later: when it is first created, play
 * time recorded before it existed becomes one estimated session per game (dated its last play),
 * so it still counts towards that year's totals.
 *
 * Sessions are the game's history, kept through uninstalls, removals and reinstalls; each notes
 * the game's stable key (sessions recorded before that, or restored from an older backup, get it
 * here). A library total that its sessions don't cover (a session lost to a crash) is added as an
 * estimated session, so the history never shows less than the library did.
 */
export async function migrateGamesDb(database: SqlDb) {
  await database.execute(SCHEMA);
  const existing = await database.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games_play_sessions'");
  await database.execute(SESSIONS_SCHEMA);
  await database.execute('CREATE INDEX IF NOT EXISTS idx_games_play_sessions_started ON games_play_sessions(started_at)');
  // Columns added later: older sessions keep NULL until filled in below.
  const columns = await database.select<{ name: string }[]>('PRAGMA table_info(games_play_sessions)');
  if (!columns.some((c) => c.name === 'profile_id')) await database.execute('ALTER TABLE games_play_sessions ADD COLUMN profile_id INTEGER');
  if (!columns.some((c) => c.name === 'game_key')) await database.execute('ALTER TABLE games_play_sessions ADD COLUMN game_key TEXT');
  await database.execute('CREATE INDEX IF NOT EXISTS idx_games_play_sessions_key ON games_play_sessions(game_key)');
  if (!existing.length) {
    await database.execute(
      `INSERT INTO games_play_sessions (game_id, slug, title, cover, started_at, seconds, estimated)
       SELECT id, slug, title, cover, last_played, play_seconds, 1 FROM games_library
       WHERE play_seconds > 0 AND last_played IS NOT NULL`,
    );
  }
  const unkeyed = await database.select<{ title: string }[]>('SELECT DISTINCT title FROM games_play_sessions WHERE game_key IS NULL');
  for (const { title } of unkeyed) {
    await database.execute('UPDATE games_play_sessions SET game_key = $1 WHERE game_key IS NULL AND title = $2', [gameKey(title), title]);
  }
  await coverLibraryTotals(database);
}

/** Adds an estimated session for play time a library row has that its sessions don't. */
async function coverLibraryTotals(database: SqlDb) {
  const rows = await database.select<{ id: number; slug: string; title: string; cover: string | null; play_seconds: number; when: string | null }[]>(
    'SELECT id, slug, title, cover, play_seconds, COALESCE(last_played, installed_at, created_at) AS "when" FROM games_library WHERE play_seconds > 0',
  );
  if (!rows.length) return;
  const sessions = await database.select<{ slug: string; game_key: string | null; title: string; seconds: number }[]>(
    'SELECT slug, game_key, title, seconds FROM games_play_sessions',
  );
  for (const row of rows) {
    const covered = sessions.filter((s) => belongsTo({ slug: s.slug, gameKey: s.game_key, title: s.title }, row)).reduce((n, s) => n + s.seconds, 0);
    const missing = row.play_seconds - covered;
    if (missing < 60 || !row.when) continue;
    await database.execute(
      'INSERT INTO games_play_sessions (game_id, slug, title, cover, started_at, seconds, estimated, game_key) VALUES ($1,$2,$3,$4,$5,$6,1,$7)',
      [row.id, row.slug, row.title, row.cover, toIso(row.when), missing, gameKey(row.title)],
    );
  }
}

/** SQLite's CURRENT_TIMESTAMP ("2026-11-27 10:00:00", UTC) or an ISO time, as ISO. */
const toIso = (value: string) => (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}.000Z` : value);

let ready: Promise<void> | null = null;

async function db() {
  const database = await getDb();
  if (!ready) {
    ready = migrateGamesDb(database);
    ready.catch(() => (ready = null));
  }
  await ready;
  return database;
}

interface GameRowDb {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  cover: string | null;
  detail: string | null;
  status: GameStatus;
  info_hash: string | null;
  installer_dir: string | null;
  install_dir: string | null;
  exe_path: string | null;
  auto_install: number;
  delete_installer: number;
  choices: string | null;
  error: string | null;
  size_bytes: number | null;
  play_seconds: number;
  last_played: string | null;
  installed_at: string | null;
  created_at: string;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function fromRow(r: GameRowDb): LibraryGame {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle,
    cover: r.cover,
    detail: parseJson<GameDetail>(r.detail),
    status: r.status,
    infoHash: r.info_hash,
    installerDir: r.installer_dir,
    installDir: r.install_dir,
    exePath: r.exe_path,
    autoInstall: r.auto_install === 1,
    deleteInstaller: r.delete_installer === 1,
    choices: parseJson<InstallChoices>(r.choices),
    error: r.error,
    sizeBytes: r.size_bytes,
    playSeconds: r.play_seconds,
    lastPlayed: r.last_played,
    installedAt: r.installed_at,
    createdAt: r.created_at,
  };
}

const libraryTime = (value: string | null) => (value ? Date.parse(toIso(value)) || 0 : 0);

/** A library game's play time and last play from the game's whole history (every install of it). */
export function withHistory(game: LibraryGame, sessions: StatSession[]): LibraryGame {
  const stats = statsFor(game, sessions);
  const lastPlayed = libraryTime(stats.lastPlayed) > libraryTime(game.lastPlayed) ? stats.lastPlayed : game.lastPlayed;
  return { ...game, playSeconds: Math.max(game.playSeconds, stats.totalSeconds), lastPlayed };
}

/** `sessions`: the play history, when already loaded (listStatSessions). */
export async function listGames(sessions?: StatSession[]): Promise<LibraryGame[]> {
  const rows = await (await db()).select<GameRowDb[]>('SELECT * FROM games_library ORDER BY COALESCE(last_played, installed_at, created_at) DESC');
  const history = sessions ?? (await listStatSessions());
  const when = (g: LibraryGame) => libraryTime(g.lastPlayed ?? g.installedAt ?? g.createdAt);
  return rows.map((r) => withHistory(fromRow(r), history)).sort((a, b) => when(b) - when(a));
}

export async function insertGame(game: {
  slug: string;
  title: string;
  subtitle: string;
  cover: string | null;
  detail: GameDetail | null;
  status: GameStatus;
  infoHash: string | null;
  installerDir: string | null;
  autoInstall: boolean;
  deleteInstaller: boolean;
  choices: InstallChoices | null;
}): Promise<LibraryGame> {
  const database = await db();
  await database.execute(
    `INSERT INTO games_library (slug, title, subtitle, cover, detail, status, info_hash, installer_dir, auto_install, delete_installer, choices)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(slug) DO UPDATE SET title = excluded.title, subtitle = excluded.subtitle, cover = excluded.cover,
       detail = excluded.detail, status = excluded.status, info_hash = excluded.info_hash, installer_dir = excluded.installer_dir,
       auto_install = excluded.auto_install, delete_installer = excluded.delete_installer, choices = excluded.choices, error = NULL`,
    [
      game.slug,
      game.title,
      game.subtitle,
      game.cover,
      game.detail ? JSON.stringify(game.detail) : null,
      game.status,
      game.infoHash?.toLowerCase() ?? null,
      game.installerDir,
      game.autoInstall ? 1 : 0,
      game.deleteInstaller ? 1 : 0,
      game.choices ? JSON.stringify(game.choices) : null,
    ],
  );
  const rows = await database.select<GameRowDb[]>('SELECT * FROM games_library WHERE slug = $1', [game.slug]);
  return fromRow(rows[0]);
}

const COLUMNS: Record<string, string> = {
  status: 'status',
  infoHash: 'info_hash',
  installerDir: 'installer_dir',
  installDir: 'install_dir',
  exePath: 'exe_path',
  autoInstall: 'auto_install',
  deleteInstaller: 'delete_installer',
  choices: 'choices',
  error: 'error',
  sizeBytes: 'size_bytes',
  playSeconds: 'play_seconds',
  lastPlayed: 'last_played',
  installedAt: 'installed_at',
  cover: 'cover',
};

export type GamePatch = Partial<Pick<LibraryGame,
  'status' | 'infoHash' | 'installerDir' | 'installDir' | 'exePath' | 'autoInstall' | 'deleteInstaller' | 'choices' | 'error' | 'sizeBytes' | 'playSeconds' | 'lastPlayed' | 'installedAt' | 'cover'>>;

export async function updateGame(id: number, patch: GamePatch) {
  const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && COLUMNS[k]);
  if (!entries.length) return;
  const params: unknown[] = [id];
  const sets = entries.map(([k, v]) => {
    params.push(k === 'choices' ? (v == null ? null : JSON.stringify(v)) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    return `${COLUMNS[k]} = $${params.length}`;
  });
  await (await db()).execute(`UPDATE games_library SET ${sets.join(', ')} WHERE id = $1`, params);
}

export async function addPlayTime(id: number, seconds: number) {
  await (await db()).execute(
    'UPDATE games_library SET play_seconds = play_seconds + $2, last_played = $3 WHERE id = $1',
    [id, Math.max(0, Math.round(seconds)), new Date().toISOString()],
  );
}

export interface PlaySession {
  gameId: number | null;
  slug: string;
  title: string;
  cover: string | null;
  startedAt: string;
  seconds: number;
  /** Rebuilt from play time recorded before sessions were logged: its day isn't known exactly. */
  estimated: boolean;
  /** Profile that started the game; null for sessions recorded before that was noted. */
  profileId: number | null;
  /** The game's genres/tags from its source page, when it is still in the library. */
  genres: string[];
}

interface SessionRowDb {
  game_id: number | null;
  slug: string;
  title: string;
  cover: string | null;
  started_at: string;
  seconds: number;
  estimated: number;
  profile_id?: number | null;
  game_key?: string | null;
}

export async function recordPlaySession(game: Pick<LibraryGame, 'id' | 'slug' | 'title' | 'cover'>, seconds: number, endedAt = new Date(), profileId: number | null = null) {
  const secs = Math.max(0, Math.round(seconds));
  if (!secs) return;
  await (await db()).execute(
    'INSERT INTO games_play_sessions (game_id, slug, title, cover, started_at, seconds, estimated, profile_id, game_key) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)',
    [game.id, game.slug, game.title, game.cover, new Date(endedAt.getTime() - secs * 1000).toISOString(), secs, profileId, gameKey(game.title)],
  );
}

/** Every play session, for the stats (stats.statsFor). */
export async function listStatSessions(): Promise<StatSession[]> {
  const rows = await (await db()).select<SessionRowDb[]>('SELECT * FROM games_play_sessions ORDER BY started_at');
  return rows.map((r) => ({
    slug: r.slug,
    gameKey: r.game_key ?? null,
    title: r.title,
    startedAt: r.started_at,
    seconds: r.seconds,
    estimated: r.estimated === 1,
  }));
}

/**
 * Deletes a game's play history (every install of it), only when asked: uninstalling or removing
 * a game keeps it. Its library entries start again from nothing. Returns how many sessions went.
 */
export async function forgetPlayStats(game: { slug: string; title: string }): Promise<number> {
  const database = await db();
  const rows = await database.select<{ id: number; slug: string; game_key: string | null; title: string }[]>('SELECT id, slug, game_key, title FROM games_play_sessions');
  const ids = rows.filter((r) => belongsTo({ slug: r.slug, gameKey: r.game_key, title: r.title }, game)).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await database.execute(`DELETE FROM games_play_sessions WHERE id IN (${chunk.map((_, j) => `$${j + 1}`).join(',')})`, chunk);
  }
  const library = await database.select<{ id: number; slug: string; title: string }[]>('SELECT id, slug, title FROM games_library');
  for (const row of library) {
    if (row.slug === game.slug || gameKey(row.title) === gameKey(game.title)) {
      await database.execute('UPDATE games_library SET play_seconds = 0, last_played = NULL WHERE id = $1', [row.id]);
    }
  }
  return ids.length;
}

function genresOf(detail: string | null): string[] {
  const genres = parseJson<GameDetail>(detail)?.genres;
  return Array.isArray(genres) ? genres.map((g) => String(g).trim()).filter(Boolean) : [];
}

export async function listPlaySessions(): Promise<PlaySession[]> {
  const database = await db();
  const rows = await database.select<SessionRowDb[]>('SELECT * FROM games_play_sessions ORDER BY started_at');
  const games = await database.select<{ slug: string; detail: string | null }[]>('SELECT slug, detail FROM games_library');
  const genres = new Map(games.map((g) => [g.slug, genresOf(g.detail)]));
  return rows.map((r) => ({
    gameId: r.game_id,
    slug: r.slug,
    title: r.title,
    cover: r.cover,
    startedAt: r.started_at,
    seconds: r.seconds,
    estimated: r.estimated === 1,
    profileId: r.profile_id ?? null,
    genres: genres.get(r.slug) ?? [],
  }));
}

export async function deleteGame(id: number) {
  await (await db()).execute('DELETE FROM games_library WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Settings (stored in the shared settings table under games_* keys)
// ---------------------------------------------------------------------------

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  sourceUrl: '',
  downloadDir: '',
  installDir: '',
  autoInstall: true,
  deleteInstaller: true,
  installRedists: false,
  desktopShortcut: true,
};

/** Where each game setting is stored (backups carry them: src/services/backupManifest.json). */
export const SETTING_KEYS: Record<keyof GameSettings, string> = {
  sourceUrl: 'games_source_url',
  downloadDir: 'games_download_dir',
  installDir: 'games_install_dir',
  autoInstall: 'games_auto_install',
  deleteInstaller: 'games_delete_installer',
  installRedists: 'games_install_redists',
  desktopShortcut: 'games_desktop_shortcut',
};

export async function loadGameSettings(): Promise<GameSettings> {
  const rows = await (await db()).select<{ key: string; value: string }[]>("SELECT key, value FROM settings WHERE key LIKE 'games_%'");
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out: GameSettings = { ...DEFAULT_GAME_SETTINGS };
  for (const [field, key] of Object.entries(SETTING_KEYS) as [keyof GameSettings, string][]) {
    const raw = map.get(key);
    if (raw == null) continue;
    if (typeof DEFAULT_GAME_SETTINGS[field] === 'boolean') (out[field] as boolean) = raw === 'true' || raw === '1';
    else (out[field] as string) = raw;
  }
  return out;
}

export async function saveGameSettings(patch: Partial<GameSettings>) {
  const database = await db();
  for (const [field, value] of Object.entries(patch) as [keyof GameSettings, string | boolean][]) {
    await database.execute(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [SETTING_KEYS[field], String(value)],
    );
  }
}
