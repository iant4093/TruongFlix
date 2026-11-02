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
