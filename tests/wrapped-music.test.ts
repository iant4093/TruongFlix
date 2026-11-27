import { describe, expect, it } from 'vitest';
import type { MusicPlayRow } from '../src/services/musicdb';
import { computeMusicWrapped, dayPart, longestRun, playYears } from '../src/services/wrapped';

let n = 0;
/** A play at a local time on `day` (YYYY-MM-DD). */
const play = (title: string, day: string, extra: Partial<MusicPlayRow> & { hour?: number } = {}): MusicPlayRow => {
  const { hour = 20, ...rest } = extra;
  const [y, m, d] = day.split('-').map(Number);
  return {
    trackId: title.charCodeAt(0),
    title,
    artist: 'Luma Vale',
    artistId: 1,
    album: 'Neon Harbour',
    albumId: 1,
    albumArtist: 'Luma Vale',
    genre: 'Synth Pop',
    art: `${title}.jpg`,
    duration: 200,
    playedAt: new Date(y, m - 1, d, hour, n++ % 60).getTime(),
    seconds: 180,
    ...rest,
  };
};

describe('computeMusicWrapped', () => {
  const plays: MusicPlayRow[] = [
    play('Glass Tides', '2026-01-03', { hour: 23 }),
    play('Afterglow', '2026-03-01', { seconds: null }), // no time recorded: counts as its 200 s
    play('Glass Tides', '2026-03-02', { hour: 23 }),
    play('Glass Tides', '2026-03-02', { hour: 23 }),
    play('Glass Tides', '2026-03-02', { hour: 23 }),
    play('Copper Moon', '2026-03-03', { artist: 'The Quiet Orbit feat. Luma Vale', artistId: 2, album: 'Paper Satellites', albumId: 2, albumArtist: 'The Quiet Orbit', genre: 'Indie; Dream Pop', seconds: 600 }),
    play('Weightless', '2026-03-03', { artist: 'The Quiet Orbit', artistId: 3, album: 'Paper Satellites', albumId: 2, albumArtist: 'The Quiet Orbit', genre: 'indie', seconds: 300, hour: 9 }),
    play('Old Song', '2025-12-31', { seconds: 9999 }),
  ];

  it('totals the year’s listening, using the song length when no time was recorded', () => {
    const w = computeMusicWrapped(plays, 2026)!;
    expect(w.seconds).toBe(180 * 4 + 200 + 600 + 300);
    expect(w.plays).toBe(7);
    expect(w.songs).toBe(4);
    expect(w.albums).toBe(2);
    expect(w.days).toBe(4);
  });

  it('ranks songs by plays and artists by time, joining “feat.” guests to the main artist', () => {
    const w = computeMusicWrapped(plays, 2026)!;
    expect(w.topSongs[0]).toMatchObject({ title: 'Glass Tides', plays: 4 });
    expect(w.artists).toBe(2);
    expect(w.topArtists.map((a) => a.name)).toEqual(['Luma Vale', 'The Quiet Orbit']);
    expect(w.topArtists[1]).toMatchObject({ seconds: 900, plays: 2, songs: 2, art: expect.stringMatching(/\.jpg$/) });
    expect(w.topAlbums.map((a) => a.title)).toEqual(['Neon Harbour', 'Paper Satellites']);
  });

  it('splits genre tags and merges them case-insensitively', () => {
    const w = computeMusicWrapped(plays, 2026)!;
    expect(w.topGenres).toEqual([
      { name: 'Synth Pop', seconds: 180 * 4 + 200 },
      { name: 'Indie', seconds: 900 },
      { name: 'Dream Pop', seconds: 600 },
    ]);
  });

  it('finds the streak, the song on repeat, the busiest day, the first song and the time of day', () => {
    const w = computeMusicWrapped(plays, 2026)!;
    expect(w.longestStreak).toEqual({ days: 3, from: '2026-03-01', to: '2026-03-03' });
    expect(w.onRepeat).toMatchObject({ title: 'Glass Tides', plays: 3, day: '2026-03-02' });
    expect(w.busiestDay).toEqual({ day: '2026-03-03', seconds: 900, plays: 2 });
    expect(w.firstSong).toMatchObject({ title: 'Glass Tides', day: '2026-01-03' });
    expect(w.timeOfDay?.part).toBe('evening'); // 20:xx carries the most time (600 s + 200 s)
    expect(w.months?.[0]).toBe(180);
    expect(w.months?.[2]).toBe(180 * 3 + 200 + 600 + 300);
  });

  it('returns null when nothing (or under a minute) was listened to that year', () => {
    expect(computeMusicWrapped([], 2026)).toBeNull();
    expect(computeMusicWrapped(plays, 2024)).toBeNull();
    expect(computeMusicWrapped([play('Short', '2026-05-01', { seconds: 40 })], 2026)).toBeNull();
  });

  it('leaves out every stat a single play can’t fill', () => {
    const w = computeMusicWrapped([play('Only', '2026-05-01', { genre: null, seconds: 240 })], 2026)!;
    expect(w).toMatchObject({ seconds: 240, plays: 1, songs: 1, artists: 1, albums: 1, days: 1 });
    expect(w.topGenres).toEqual([]);
    expect(w.longestStreak).toBeNull();
    expect(w.onRepeat).toBeNull();
    expect(w.busiestDay).toBeNull();
    expect(w.firstSong).toBeNull();
    expect(w.timeOfDay).toBeNull();
    expect(w.months).toBeNull();
  });

  it('needs three plays of a song in a day for “on repeat”', () => {
    const w = computeMusicWrapped([play('A', '2026-02-01'), play('A', '2026-02-01'), play('B', '2026-02-02')], 2026)!;
    expect(w.onRepeat).toBeNull();
  });
});

describe('music helpers', () => {
  it('lists years with plays, newest first', () => {
    expect(playYears([play('a', '2024-01-01'), play('b', '2026-06-01'), play('c', '2024-07-01')])).toEqual([2026, 2024]);
  });
  it('splits the day into parts', () => {
    expect([4, 5, 11, 12, 16, 17, 21, 22, 0].map(dayPart)).toEqual(['night', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night']);
  });
  it('finds the longest run of days', () => {
    expect(longestRun(['2026-01-01', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-04'])).toEqual({ days: 3, from: '2026-01-03', to: '2026-01-05' });
    expect(longestRun([])).toBeNull();
  });
});
