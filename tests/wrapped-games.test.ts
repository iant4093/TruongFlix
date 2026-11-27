import { describe, expect, it } from 'vitest';
import { computeGameWrapped, localDay, profileSessions, sessionYears, type GameSessionRow } from '../src/services/wrapped';

/** Session starting at local noon on `day` (avoids time-zone edge cases in assertions). */
const s = (slug: string, day: string, seconds: number, extra: Partial<GameSessionRow> = {}): GameSessionRow => ({
  slug, title: slug.toUpperCase(), cover: `${slug}.jpg`, startedAt: new Date(`${day}T12:00:00`).toISOString(), seconds, estimated: false, ...extra,
});

describe('computeGameWrapped', () => {
  const sessions = [
    s('a', '2026-03-01', 3600),
    s('a', '2026-03-01', 1800),
    s('b', '2026-04-10', 4 * 3600),
    s('c', '2026-05-02', 600),
    s('a', '2026-06-01', 3600, { title: 'A Remastered', cover: 'a2.jpg' }),
    s('d', '2025-12-31', 9 * 3600),
    s('e', '2026-01-05', 20 * 3600, { estimated: true }),
  ];

  it('totals the year and ranks games by play time', () => {
    const w = computeGameWrapped(sessions, 2026)!;
    expect(w.seconds).toBe(3600 + 1800 + 4 * 3600 + 600 + 3600 + 20 * 3600);
    expect(w.games).toBe(4);
    expect(w.sessions).toBe(5); // estimated sessions aren't real sessions
    expect(w.topGames.map((g) => g.slug)).toEqual(['e', 'b', 'a', 'c']);
    expect(w.topGames.find((g) => g.slug === 'a')).toMatchObject({ seconds: 9000, sessions: 3, title: 'A Remastered', cover: 'a2.jpg' });
  });

  it('limits the top list', () => {
    expect(computeGameWrapped(sessions, 2026, 3)!.topGames).toHaveLength(3);
  });

  it('longest session and busiest day ignore estimated time', () => {
    const w = computeGameWrapped(sessions, 2026)!;
    expect(w.longestSession).toEqual({ title: 'B', cover: 'b.jpg', seconds: 4 * 3600, day: '2026-04-10' });
    // 2026-03-01 adds up to 1.5 h, less than the 4 h session, so it would only repeat that card.
    expect(w.busiestDay).toBeNull();
  });

  it('shows the busiest day when several sessions beat the longest one', () => {
    const w = computeGameWrapped([s('a', '2026-02-01', 3000), s('b', '2026-02-01', 3000), s('c', '2026-02-02', 4000)], 2026)!;
    expect(w.longestSession?.seconds).toBe(4000);
    expect(w.busiestDay).toEqual({ day: '2026-02-01', seconds: 6000 });
  });

  it('returns null for years with under a minute played', () => {
    expect(computeGameWrapped(sessions, 2024)).toBeNull();
    expect(computeGameWrapped([s('a', '2026-01-01', 30)], 2026)).toBeNull();
    expect(computeGameWrapped([], 2026)).toBeNull();
  });

  it('skips broken rows', () => {
    const w = computeGameWrapped([s('a', '2026-01-01', 600), { ...s('b', '2026-01-01', 600), startedAt: 'nope' }, s('c', '2026-01-01', -5)], 2026)!;
    expect(w.seconds).toBe(600);
    expect(w.games).toBe(1);
  });
});

describe('session helpers', () => {
  it('lists years with play time, newest first', () => {
    expect(sessionYears([s('a', '2024-05-01', 60), s('a', '2026-05-01', 60), s('a', '2025-05-01', 0)])).toEqual([2026, 2024]);
  });
  it('uses the local calendar day', () => {
    expect(localDay(new Date(2026, 0, 2, 0, 30).toISOString())).toBe('2026-01-02');
    expect(localDay('bad')).toBeNull();
  });
});

describe('computeGameWrapped extras', () => {
  const at = (slug: string, day: string, hour: number, seconds: number, extra: Partial<GameSessionRow> = {}): GameSessionRow => ({
    ...s(slug, day, seconds, extra), startedAt: new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString(),
  });

  it('adds days, a streak, the average session, genres, the time of day and months', () => {
    const w = computeGameWrapped([
      at('a', '2026-03-01', 22, 3600, { genres: ['Action', 'RPG'] }),
      at('a', '2026-03-02', 23, 3600, { genres: ['action', 'RPG'] }),
      at('b', '2026-03-03', 14, 1800, { genres: ['Puzzle'] }),
      at('b', '2026-05-10', 23, 1800, { genres: ['Puzzle'] }),
      at('c', '2026-06-01', 12, 7200, { estimated: true, genres: ['Racing'] }),
    ], 2026)!;
    expect(w.days).toBe(4);
    expect(w.longestStreak).toEqual({ days: 3, from: '2026-03-01', to: '2026-03-03' });
    expect(w.averageSession).toBe((3600 * 2 + 1800 * 2) / 4);
    expect(w.topGenres).toEqual([
      { name: 'Racing', seconds: 7200 },
      { name: 'Action', seconds: 7200 },
      { name: 'RPG', seconds: 7200 },
      { name: 'Puzzle', seconds: 3600 },
    ].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name)));
    expect(w.timeOfDay).toEqual({ part: 'night', share: (3600 * 2 + 1800) / (3600 * 2 + 1800 * 2) });
    expect(w.months?.[2]).toBe(9000);
    expect(w.months?.[4]).toBe(1800);
    expect(w.shared).toBe(true); // rows without a profile are from before sessions noted who played
  });

  it('leaves out stats one session can’t fill', () => {
    const w = computeGameWrapped([at('a', '2026-03-01', 20, 3600, { profileId: 1 })], 2026)!;
    expect(w).toMatchObject({ seconds: 3600, sessions: 1, games: 1, days: 1, shared: false });
    expect(w.longestSession).not.toBeNull();
    expect(w.busiestDay).toBeNull();
    expect(w.averageSession).toBeNull();
    expect(w.longestStreak).toBeNull();
    expect(w.topGenres).toEqual([]);
    expect(w.timeOfDay).toBeNull();
    expect(w.months).toBeNull();
  });

  it('only estimated time: no session stats at all', () => {
    const w = computeGameWrapped([s('a', '2026-01-05', 5 * 3600, { estimated: true })], 2026)!;
    expect(w).toMatchObject({ sessions: 0, days: 0, longestSession: null, busiestDay: null, averageSession: null, longestStreak: null, timeOfDay: null, months: null });
  });
});

describe('profileSessions', () => {
  it('keeps this profile’s sessions and ones recorded before profiles were noted', () => {
    const rows = [s('a', '2026-01-01', 60, { profileId: 1 }), s('b', '2026-01-01', 60, { profileId: 2 }), s('c', '2026-01-01', 60, { profileId: null }), s('d', '2026-01-01', 60)];
    expect(profileSessions(rows, 1).map((r) => r.slug)).toEqual(['a', 'c', 'd']);
    expect(profileSessions(rows, 2).map((r) => r.slug)).toEqual(['b', 'c', 'd']);
  });
});
