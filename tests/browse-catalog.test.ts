import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getCatalog, getCatalogSeason, setApiKey } from '../src/services/tmdb';
import type { CatalogDetail } from '../src/types/browse';
vi.mock('../src/services/db', () => ({ saveSeasonCache: vi.fn(async () => {}) }));
const detail = { id: 1, kind: 'tv', title: 'Example', year: 2024, status: 'Returning Series', seasons: [{ number: 1, count: 2 }], lastSeason: 1, lastEpisode: 2, nextSeason: null } as CatalogDetail;
beforeEach(() => { setApiKey('fixture'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const fetchSeason = (patch = {}) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ episodes: [1, 2].map((episode_number) => ({
  id: episode_number, name: `Episode ${episode_number}`, season_number: 1, episode_number, air_date: '2024-01-01', ...patch,
})) }), { status: 200 })));
it('does not infer that an ongoing current season is complete just because its listed episodes have aired', async () => {
  fetchSeason(); expect((await getCatalogSeason(detail, 1)).complete).toBe(false);
});
it('accepts exact aired coverage for a closed season', async () => {
  fetchSeason(); expect((await getCatalogSeason({ ...detail, nextSeason: 2 }, 1)).complete).toBe(true);
});
it('rejects incomplete counts, missing air dates, and future episodes', async () => {
  fetchSeason(); expect((await getCatalogSeason({ ...detail, status: 'Ended', seasons: [{ number: 1, count: 3, name: 'Season 1', airDate: '2024-01-01' }] }, 1)).complete).toBe(false);
  fetchSeason({ air_date: null }); expect((await getCatalogSeason({ ...detail, status: 'Ended' }, 1)).complete).toBe(false);
  fetchSeason({ air_date: '2999-01-01' }); expect((await getCatalogSeason({ ...detail, status: 'Ended' }, 1)).complete).toBe(false);
});
it('uses TV and movie discovery endpoints and omits adult results', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total_pages: 2, results: [{ id: 5, name: 'A Show', first_air_date: '2024-03-01' }, { id: 6, name: 'Excluded', adult: true }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const data = await getCatalog('tv', 'new');
  expect(new URL(fetcher.mock.calls[0][0]).pathname).toBe('/3/tv/on_the_air');
  expect(data.items.map((i) => i.title)).toEqual(['A Show']);
});

it('loads cast, crew, artwork and full movie information for the catalog dialog', async () => {
  const { getCatalogDetail } = await import('../src/services/tmdb');
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 5, title: 'A Film', release_date: '2024-03-01',
    tagline: 'A tagline', overview: 'Full overview', runtime: 110, status: 'Released', original_language: 'en', imdb_id: 'tt1234567',
    vote_average: 8.2, poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg', genres: [{ name: 'Drama' }],
    credits: { cast: [{ id: 10, name: 'An Actor', character: 'A Character', profile_path: '/person.jpg' }], crew: [{ id: 11, name: 'A Director', job: 'Director' }] },
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] }] },
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const result = await getCatalogDetail({ id: 5, title: 'A Film', kind: 'movie', year: 2024, overview: '', poster: null, backdrop: null, voteAverage: 0 });
  expect(result).toMatchObject({ tagline: 'A tagline', certification: 'PG-13', runtime: 110, status: 'Released', language: 'en', releaseDate: '2024-03-01',
    cast: [{ id: 10, name: 'An Actor', character: 'A Character' }, { id: 11, name: 'A Director', job: 'Director' }] });
  expect(result.backdrop).toContain('/w1280/backdrop.jpg');
  expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('append_to_response')).toContain('credits');
});
