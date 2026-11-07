import { getDb } from '../services/db';
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
  estimated INTEGER NOT NULL DEFAULT 0 -- 1 = rebuilt from a game's total play time
)`;

type SqlDb = {
  select<T>(query: string, values?: unknown[]): Promise<T>;
  execute(query: string, values?: unknown[]): Promise<unknown>;
};

/**
 * Creates the library tables. The sessions table was added later: when it is first created, play
 * time recorded before it existed becomes one estimated session per game (dated its last play),
 * so it still counts towards that year's totals.
 */
export async function migrateGamesDb(database: SqlDb) {
  await database.execute(SCHEMA);
  const existing = await database.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games_play_sessions'");
  await database.execute(SESSIONS_SCHEMA);
  await database.execute('CREATE INDEX IF NOT EXISTS idx_games_play_sessions_started ON games_play_sessions(started_at)');
  if (existing.length) return;
  await database.execute(
    `INSERT INTO games_play_sessions (game_id, slug, title, cover, started_at, seconds, estimated)
     SELECT id, slug, title, cover, last_played, play_seconds, 1 FROM games_library
     WHERE play_seconds > 0 AND last_played IS NOT NULL`,
  );
}

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

export async function listGames(): Promise<LibraryGame[]> {
  const rows = await (await db()).select<GameRowDb[]>('SELECT * FROM games_library ORDER BY COALESCE(last_played, installed_at, created_at) DESC');
  return rows.map(fromRow);
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
}

interface SessionRowDb {
  game_id: number | null;
  slug: string;
  title: string;
  cover: string | null;
  started_at: string;
  seconds: number;
  estimated: number;
}

export async function recordPlaySession(game: Pick<LibraryGame, 'id' | 'slug' | 'title' | 'cover'>, seconds: number, endedAt = new Date()) {
  const secs = Math.max(0, Math.round(seconds));
  if (!secs) return;
  await (await db()).execute(
    'INSERT INTO games_play_sessions (game_id, slug, title, cover, started_at, seconds, estimated) VALUES ($1,$2,$3,$4,$5,$6,0)',
    [game.id, game.slug, game.title, game.cover, new Date(endedAt.getTime() - secs * 1000).toISOString(), secs],
  );
}

export async function listPlaySessions(): Promise<PlaySession[]> {
  const rows = await (await db()).select<SessionRowDb[]>('SELECT * FROM games_play_sessions ORDER BY started_at');
  return rows.map((r) => ({
    gameId: r.game_id,
    slug: r.slug,
    title: r.title,
    cover: r.cover,
    startedAt: r.started_at,
    seconds: r.seconds,
    estimated: r.estimated === 1,
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

const SETTING_KEYS: Record<keyof GameSettings, string> = {
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
