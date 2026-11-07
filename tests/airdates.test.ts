import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  airDayLabel,
  buildSchedule,
  clearAirScheduleCache,
  daysUntil,
  earliestAirDate,
  getAirSchedule,
  localDateKey,
  mergeNextEpisode,
  mergeSeasonAirDates,
  parseLocalDate,
  seasonNeedsSchedule,
  tvmazeLocalDate,
} from '../src/services/airdates';
import { newEpisodeSoon } from '../src/store/selectors';

// Dexter: Resurrection season 2. TMDB lists the Sunday broadcast; the streaming release is the Friday before.
const tmdbSeason2 = [
  ['Risky Business', '2026-11-01'], ['Fallen', '2026-11-08'], ['Live Free and Die', '2026-11-15'], ['Young Blood', '2026-11-22'],
  ['Panic Attack', '2026-11-29'], ['Out of the Past', '2026-12-06'],
].map(([name, air_date], i) => ({ episode_number: i + 1, name, air_date }));
const tvmazeSeason2 = ['2026-10-30', '2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27', '2026-12-04'].map((airdate, i) => ({
  season: 2, number: i + 1, name: tmdbSeason2[i].name, airdate, airstamp: `${airdate}T12:00:00+00:00`,
}));
const schedule = buildSchedule([
  ...tvmazeSeason2,
  { season: 2, number: null, name: 'Special', airdate: '2026-11-10', airstamp: '2026-11-10T12:00:00+00:00' },
]);
// Saturday Nov 7 2026, evening (local time).
const now = new Date(2026, 10, 7, 21, 30);
const today = localDateKey(now);

beforeEach(() => vi.useFakeTimers({ now, toFake: ['Date'] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearAirScheduleCache();
});

describe('local dates', () => {
  it('parses YYYY-MM-DD as a local calendar date, not UTC midnight', () => {
    const d = parseLocalDate('2026-11-13');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 10, 13]);
    expect(d.getDay()).toBe(5); // Friday
  });

  it('formats today from the local clock, not the UTC one', () => {
    expect(localDateKey(new Date(2026, 10, 7, 23, 59))).toBe('2026-11-07');
    expect(localDateKey(new Date(2026, 10, 8, 0, 1))).toBe('2026-11-08');
  });

  it('reads TVmaze airstamps as the local date of that instant, else the listed date', () => {
    const stamp = '2026-11-13T12:00:00+00:00';
    expect(tvmazeLocalDate({ airstamp: stamp, airdate: '2026-11-13' })).toBe(localDateKey(new Date(stamp)));
    expect(tvmazeLocalDate({ airstamp: null, airdate: '2026-11-13' })).toBe('2026-11-13');
    expect(tvmazeLocalDate({ airstamp: null, airdate: '' })).toBeNull();
  });

  it('counts calendar days and labels the weekday within the coming week', () => {
    expect(daysUntil('2026-11-13', now)).toBe(6);
    expect(daysUntil('2026-11-07', now)).toBe(0);
    expect(airDayLabel('2026-11-07', now)).toBe('Today');
    expect(airDayLabel('2026-11-08', now)).toBe('Tomorrow');
    expect(airDayLabel('2026-11-13', now)).toBe(parseLocalDate('2026-11-13').toLocaleDateString(undefined, { weekday: 'long' }));
    expect(airDayLabel('2026-11-15', now)).toBe(parseLocalDate('2026-11-15').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  });
});

describe('merging TMDB and TVmaze', () => {
  it('uses the earliest release for each episode', () => {
    expect(earliestAirDate('2026-11-15', '2026-11-13')).toBe('2026-11-13');
    expect(earliestAirDate('2026-11-13', '2026-11-15')).toBe('2026-11-13');
    expect(earliestAirDate(null, '2026-11-13')).toBe('2026-11-13');
    expect(earliestAirDate('2026-11-15', null)).toBe('2026-11-15');
    // Far earlier usually means mismatched numbering, not an early release.
    expect(earliestAirDate('2026-11-15', '2026-09-01')).toBe('2026-11-15');
  });

  it('moves the Dexter season 2 episodes onto their Friday streaming releases', () => {
    const merged = mergeSeasonAirDates(2, tmdbSeason2, schedule);
    const fridays = tvmazeSeason2.map((e) => localDateKey(new Date(e.airstamp)));
    expect(merged.map((e) => e.air_date)).toEqual(fridays);
    expect(merged[2]).toMatchObject({ name: 'Live Free and Die' });
    expect(mergeSeasonAirDates(3, tmdbSeason2, schedule)).toEqual(tmdbSeason2);
    expect(mergeSeasonAirDates(2, tmdbSeason2, null)).toBe(tmdbSeason2);
  });

  it('skips past an episode TMDB still lists as upcoming but which is already streaming', () => {
    // A day after episode 2 started streaming, in every time zone.
    const later = new Date('2026-11-07T14:00:00Z');
    const tmdbNext = { season: 2, episode: 2, name: 'Fallen', air_date: '2026-11-08' };
    const next = mergeNextEpisode(tmdbNext, schedule, localDateKey(later));
    expect(next).toMatchObject({ season: 2, episode: 3, name: 'Live Free and Die' });
    expect(next!.air_date).toBe(localDateKey(new Date('2026-11-13T12:00:00+00:00')));
    expect(next!.air_date < '2026-11-15').toBe(true);
    expect(newEpisodeSoon(next, later)).toBe(true);
  });

  it('keeps TMDB alone when TVmaze has nothing', () => {
    const tmdbNext = { season: 2, episode: 3, name: 'Live Free and Die', air_date: '2026-11-15' };
    expect(mergeNextEpisode(tmdbNext, null, today)).toBe(tmdbNext);
    expect(mergeNextEpisode(tmdbNext, buildSchedule([]), today)).toEqual(tmdbNext);
  });

  it('only consults TVmaze for seasons with recent, upcoming or undated episodes', () => {
    expect(seasonNeedsSchedule(['2025-07-13', '2025-09-07'], today)).toBe(false);
    expect(seasonNeedsSchedule(['2026-11-01', '2026-11-15'], today)).toBe(true);
    expect(seasonNeedsSchedule(['2025-07-13', null], today)).toBe(true);
  });
});

describe('TVmaze client', () => {
  it('looks the show up by IMDb id, caches it and falls back to TMDB when unreachable', async () => {
    vi.useRealTimers();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/lookup/shows')) return new Response(JSON.stringify({ id: 78665 }), { status: 200 });
      return new Response(JSON.stringify(tvmazeSeason2), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const first = await getAirSchedule(259909, () => ({ imdb: 'tt33043892' }));
    expect(first?.byKey.get('2:3')?.name).toBe('Live Free and Die');
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([
      'https://api.tvmaze.com/lookup/shows?imdb=tt33043892',
      'https://api.tvmaze.com/shows/78665/episodes',
    ]);
    await getAirSchedule(259909, () => ({ imdb: 'tt33043892' }));
    expect(fetcher).toHaveBeenCalledTimes(2);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await getAirSchedule(1, () => ({ imdb: 'tt0000001' }))).toBeNull();
  });
});
