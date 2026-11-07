import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Just enough SQLite for the games tables: which tables exist, and every statement run. */
function fakeDb(existingTables: string[] = []) {
  const tables = new Set(existingTables);
  const statements: { query: string; values?: unknown[] }[] = [];
  const sessions: unknown[][] = [];
  return {
    tables,
    statements,
    sessions,
    async select<T>(query: string, values?: unknown[]): Promise<T> {
      statements.push({ query, values });
      if (query.includes('sqlite_master')) return (tables.has('games_play_sessions') ? [{ name: 'games_play_sessions' }] : []) as T;
      return [] as T;
    },
    async execute(query: string, values?: unknown[]) {
      statements.push({ query, values });
      const created = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(query);
      if (created) tables.add(created[1]);
      if (query.startsWith('INSERT INTO games_play_sessions') && values) sessions.push(values);
      return { rowsAffected: 1 };
    },
  };
}

let db = fakeDb();
vi.mock('../src/services/db', () => ({ getDb: async () => db }));

const { migrateGamesDb, recordPlaySession } = await import('../src/games/library');
const backfills = (d: ReturnType<typeof fakeDb>) => d.statements.filter((st) => st.query.includes('SELECT id, slug, title, cover, last_played, play_seconds, 1'));

describe('games sessions migration', () => {
  it('creates the sessions table and turns earlier play time into estimated sessions once', async () => {
    const d = fakeDb(['games_library']);
    await migrateGamesDb(d);
    expect(d.tables.has('games_play_sessions')).toBe(true);
    expect(d.statements.some((st) => st.query.includes('CREATE INDEX IF NOT EXISTS idx_games_play_sessions_started'))).toBe(true);
    expect(backfills(d)).toHaveLength(1);
    expect(backfills(d)[0].query).toMatch(/WHERE play_seconds > 0 AND last_played IS NOT NULL/);

    // Next start: the table exists, so nothing is copied again.
    await migrateGamesDb(d);
    expect(backfills(d)).toHaveLength(1);
  });

  it('only adds tables (never drops or rewrites the library)', async () => {
    const d = fakeDb();
    await migrateGamesDb(d);
    expect(d.statements.some((st) => /^\s*(DROP|ALTER|DELETE|UPDATE)\b/i.test(st.query))).toBe(false);
    expect(d.tables).toEqual(new Set(['games_library', 'games_play_sessions']));
  });
});

describe('recordPlaySession', () => {
  beforeEach(() => { db = fakeDb(['games_library', 'games_play_sessions']); });

  it('stores when the session started, from its end time and length', async () => {
    const ended = new Date('2026-11-07T20:00:00.000Z');
    await recordPlaySession({ id: 3, slug: 'trees', title: 'Trees', cover: 'c.jpg' }, 5400.4, ended);
    expect(db.sessions).toEqual([[3, 'trees', 'Trees', 'c.jpg', '2026-11-07T18:30:00.000Z', 5400]]);
  });

  it('ignores empty sessions', async () => {
    await recordPlaySession({ id: 3, slug: 'trees', title: 'Trees', cover: null }, 0);
    expect(db.sessions).toEqual([]);
  });
});
