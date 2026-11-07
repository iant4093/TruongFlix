import { describe, expect, it } from 'vitest';
import { computeGameWrapped, localDay, sessionYears, type GameSessionRow } from '../src/services/wrapped';

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
