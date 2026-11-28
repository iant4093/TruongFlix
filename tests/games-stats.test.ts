import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from './sqlite';
import { gameKey, startOfWeek, statsFor, type StatSession } from '../src/games/stats';

let db = memoryDb();
vi.mock('../src/services/db', () => ({ getDb: async () => db }));

describe('a game’s identity', () => {
  it('ignores case, accents, symbols, versions, DLC counts and edition names', () => {
    const same = ['Some Game', 'some game', 'Some Game™', 'Some Game: Deluxe Edition', 'Some Game v1.2.3', 'Some Game (Build 18213) + 4 DLCs', 'Somé Game – GOTY'];
    expect(new Set(same.map(gameKey))).toEqual(new Set(['some game']));
    expect(gameKey('Tom & Jerry')).toBe(gameKey('Tom and Jerry'));
  });

  it('keeps sequels and different games apart', () => {
    expect(gameKey('Some Game 2')).not.toBe(gameKey('Some Game'));
    expect(gameKey('Some Game: Origins')).not.toBe(gameKey('Some Game'));
    expect(gameKey('Edition')).toBe('edition'); // never empty
  });
});

describe('play stats', () => {
  const now = new Date(2026, 10, 27, 20, 0); // Friday 27 Nov 2026, 8 pm local
  const at = (month: number, day: number, hour: number) => new Date(2026, month, day, hour).toISOString();
  const session = (startedAt: string, seconds: number, extra: Partial<StatSession> = {}): StatSession =>
    ({ slug: 'trees-v1', gameKey: 'trees', title: 'Trees', startedAt, seconds, estimated: false, ...extra });
  const sessions = [
    session(at(9, 2, 18), 600, { estimated: true }), // before sessions were logged
    session(at(10, 1, 20), 7200), // 1 Nov
    session(at(10, 22, 23), 3 * 3600), // Sunday 22 Nov 23:00 → Monday 02:00 (over the week start)
    session(at(10, 26, 21), 1800, { slug: 'trees-v2', gameKey: null, title: 'Trees: Deluxe Edition' }), // another repack
    session(at(10, 26, 22), 900, { slug: 'rocks', gameKey: 'rocks', title: 'Rocks' }),
    session(at(10, 27, 12), 0),
  ];

  it('adds up every install of the game', () => {
    const stats = statsFor({ slug: 'trees-v3', title: 'Trees' }, sessions, now);
    expect(stats).toEqual({
      totalSeconds: 600 + 7200 + 3 * 3600 + 1800,
      launches: 3,
      hasEstimated: true,
      firstPlayed: at(9, 2, 18),
      firstPlayedApprox: true,
      lastPlayed: new Date(2026, 10, 26, 21, 30).toISOString(),
      longestSeconds: 3 * 3600,
      weekSeconds: 2 * 3600 + 1800,
      monthSeconds: 7200 + 3 * 3600 + 1800,
    });
  });

  it('finds the game by its source slug even when the title changed', () => {
    expect(statsFor({ slug: 'trees-v1', title: 'Trees Remastered' }, sessions, now).totalSeconds).toBe(600 + 7200 + 3 * 3600);
  });

  it('is empty for a game never played', () => {
    expect(statsFor({ slug: 'water', title: 'Water' }, sessions, now)).toMatchObject({ totalSeconds: 0, launches: 0, lastPlayed: null, firstPlayed: null });
  });

  it('starts the week on Monday', () => {
    expect(startOfWeek(now)).toEqual(new Date(2026, 10, 23));
    expect(startOfWeek(new Date(2026, 10, 23, 0, 0, 1))).toEqual(new Date(2026, 10, 23));
    expect(startOfWeek(new Date(2026, 10, 22, 23))).toEqual(new Date(2026, 10, 16));
  });
});

// ---------------------------------------------------------------------------
// Against a real SQLite database
// ---------------------------------------------------------------------------

type Library = typeof import('../src/games/library');

/** What jobs.creditPlayTime does when a session ends. */
async function play(lib: Library, game: { id: number; slug: string; title: string; cover: string | null }, seconds: number, endedAt: Date) {
  await lib.addPlayTime(game.id, seconds);
  await lib.recordPlaySession(game, seconds, endedAt, 1);
}
const T = (h: number) => new Date(Date.UTC(2026, 10, 20, h));

describe('stats across uninstalls and reinstalls', () => {
  beforeEach(() => { db = memoryDb(); vi.resetModules(); });

  it('keeps the history when a game is uninstalled and a newer repack installed elsewhere', async () => {
    const lib = await import('../src/games/library');
    const first = await lib.insertGame({ slug: 'trees-v1-0', title: 'Trees', subtitle: 'v1.0', cover: null, detail: null, status: 'downloaded', infoHash: null, installerDir: null, autoInstall: true, deleteInstaller: true, choices: null });
    await lib.updateGame(first.id, { status: 'installed', installDir: 'C:\\Games\\Trees', exePath: 'C:\\Games\\Trees\\Trees.exe' });
    await play(lib, first, 3600, T(10));
    await play(lib, first, 1800, T(14));

    // Uninstalled (no installer kept): the library entry goes.
    await lib.deleteGame(first.id);
    expect(await lib.listGames()).toEqual([]);

    // Redownloaded later as another repack version, into another folder.
    const again = await lib.insertGame({ slug: 'trees-v2-1', title: 'Trees – Deluxe Edition', subtitle: 'v2.1 + 3 DLCs', cover: null, detail: null, status: 'downloaded', infoHash: null, installerDir: null, autoInstall: true, deleteInstaller: true, choices: null });
    await lib.updateGame(again.id, { status: 'installed', installDir: 'E:\\Other\\Trees v2', exePath: 'E:\\Other\\Trees v2\\Trees.exe' });
    const [listed] = await lib.listGames();
    expect(listed.playSeconds).toBe(5400);
    expect(listed.lastPlayed).toBe(T(14).toISOString());

    await play(lib, listed, 600, T(20));
    const stats = statsFor(listed, await lib.listStatSessions(), T(21));
    expect(stats).toMatchObject({ totalSeconds: 6000, launches: 3, longestSeconds: 3600, firstPlayed: T(9).toISOString(), lastPlayed: T(20).toISOString() });
    expect((await lib.listGames())[0].playSeconds).toBe(6000);
  });

  it('keeps the history when a game is removed from the library, until asked to forget it', async () => {
    const lib = await import('../src/games/library');
    const game = await lib.insertGame({ slug: 'rocks', title: 'Rocks', subtitle: '', cover: null, detail: null, status: 'installed', infoHash: null, installerDir: null, autoInstall: true, deleteInstaller: true, choices: null });
    await play(lib, game, 1200, T(8));
    const other = await lib.insertGame({ slug: 'water', title: 'Water', subtitle: '', cover: null, detail: null, status: 'installed', infoHash: null, installerDir: null, autoInstall: true, deleteInstaller: true, choices: null });
    await play(lib, other, 300, T(9));
    await lib.deleteGame(game.id);
    expect(statsFor({ slug: 'rocks', title: 'Rocks' }, await lib.listStatSessions()).totalSeconds).toBe(1200);

    const back = await lib.insertGame({ slug: 'rocks', title: 'Rocks', subtitle: '', cover: null, detail: null, status: 'downloaded', infoHash: null, installerDir: null, autoInstall: true, deleteInstaller: true, choices: null });
    expect((await lib.listGames()).find((g) => g.id === back.id)?.playSeconds).toBe(1200);

    expect(await lib.forgetPlayStats(back)).toBe(1);
    const after = await lib.listGames();
    expect(after.find((g) => g.id === back.id)).toMatchObject({ playSeconds: 0, lastPlayed: null });
    expect(after.find((g) => g.id === other.id)?.playSeconds).toBe(300); // other games untouched
    // Forgotten for good: the next start doesn't rebuild it from the library total.
    await lib.migrateGamesDb(db);
    expect(statsFor(back, await lib.listStatSessions()).totalSeconds).toBe(0);
  });
});

describe('existing play history', () => {
  beforeEach(() => { db = memoryDb(); vi.resetModules(); });

  it('is keyed by game, and library time without sessions becomes an estimated session, once', async () => {
    // A database from before sessions noted the game's key or profile.
    db.raw.exec(`
      CREATE TABLE games_library (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
        cover TEXT, detail TEXT, status TEXT NOT NULL, info_hash TEXT, installer_dir TEXT, install_dir TEXT, exe_path TEXT,
        auto_install INTEGER NOT NULL DEFAULT 1, delete_installer INTEGER NOT NULL DEFAULT 1, choices TEXT, error TEXT, size_bytes INTEGER,
        play_seconds INTEGER NOT NULL DEFAULT 0, last_played TEXT, installed_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE games_play_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER, slug TEXT NOT NULL, title TEXT NOT NULL, cover TEXT,
        started_at TEXT NOT NULL, seconds INTEGER NOT NULL, estimated INTEGER NOT NULL DEFAULT 0);
      INSERT INTO games_library (slug, title, status, play_seconds, last_played) VALUES ('trees', 'Trees', 'installed', 5000, '2026-11-20T10:00:00.000Z');
      INSERT INTO games_play_sessions (game_id, slug, title, started_at, seconds) VALUES (1, 'trees', 'Trees', '2026-11-19T10:00:00.000Z', 2000);
      INSERT INTO games_play_sessions (game_id, slug, title, started_at, seconds) VALUES (NULL, 'old-rocks', 'Rocks™ Gold Edition', '2026-01-01T10:00:00.000Z', 700);
    `);
    const lib = await import('../src/games/library');
    await lib.migrateGamesDb(db);
    await lib.migrateGamesDb(db); // every start
    const rows = db.raw.prepare('SELECT slug, game_key, seconds, estimated, started_at FROM games_play_sessions ORDER BY id').all();
    expect(rows).toEqual([
      { slug: 'trees', game_key: 'trees', seconds: 2000, estimated: 0, started_at: '2026-11-19T10:00:00.000Z' },
      { slug: 'old-rocks', game_key: 'rocks', seconds: 700, estimated: 0, started_at: '2026-01-01T10:00:00.000Z' },
      { slug: 'trees', game_key: 'trees', seconds: 3000, estimated: 1, started_at: '2026-11-20T10:00:00.000Z' },
    ]);
    expect((await lib.listGames())[0].playSeconds).toBe(5000);
    expect(statsFor({ slug: 'rocks-v2', title: 'Rocks' }, await lib.listStatSessions()).totalSeconds).toBe(700);
  });
});

describe('a backup restored on another computer', () => {
  beforeEach(() => { db = memoryDb(); vi.resetModules(); });

  /**
   * backup.rs copies games_play_sessions column by column (the columns both sides have). These
   * are the rows a backup from before the key existed brings back; the next start keys them, and
   * a game downloaded again on the new computer picks its history up.
   */
  it('brings the stats back, also from a backup made before sessions noted the game', async () => {
    const lib = await import('../src/games/library');
    await lib.migrateGamesDb(db); // the new computer's empty tables
    db.raw.exec(`
      INSERT INTO games_play_sessions (game_id, slug, title, started_at, seconds, estimated, profile_id, game_key)
        VALUES (4, 'trees', 'Trees', '2026-11-01T10:00:00.000Z', 3600, 0, 1, NULL),
               (4, 'trees', 'Trees', '2026-11-02T10:00:00.000Z', 1800, 0, 1, NULL);
    `);
    vi.resetModules();
    const restarted = await import('../src/games/library');
    const game = await restarted.insertGame({ slug: 'trees-new', title: 'Trees', subtitle: '', cover: null, detail: null, status: 'downloaded', infoHash: null, installerDir: null, autoInstall: true, deleteInstaller: true, choices: null });
    expect(db.raw.prepare('SELECT DISTINCT game_key FROM games_play_sessions').all()).toEqual([{ game_key: 'trees' }]);
    expect((await restarted.listGames())[0].playSeconds).toBe(5400);
    expect(statsFor(game, await restarted.listStatSessions())).toMatchObject({ totalSeconds: 5400, launches: 2, longestSeconds: 3600 });
  });
});
