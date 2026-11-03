import { afterEach, expect, it, vi } from 'vitest';
import { cachedCriticScores } from '../src/services/omdb';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const reply = (rt: number | null, meta: number | null) => ({ json: async () => ({ Response: 'True',
  Ratings: rt == null ? [] : [{ Source: 'Rotten Tomatoes', Value: `${rt}%` }], Metascore: meta == null ? 'N/A' : String(meta) }) });

it('deduplicates concurrent requests and caches missing scores as well as available ones', async () => {
  const fetch = vi.fn().mockResolvedValue(reply(null, null)); vi.stubGlobal('fetch', fetch);
  const results = await Promise.all([cachedCriticScores('dedup-fixture', 'tt1234567'), cachedCriticScores('dedup-fixture', 'tt1234567')]);
  expect(results).toEqual([{ rt: null, metacritic: null }, { rt: null, metacritic: null }]);
  await cachedCriticScores('dedup-fixture', 'tt1234567');
  expect(fetch).toHaveBeenCalledOnce();
});

it('refreshes expired scores and separates requests using a different API key', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = vi.fn().mockResolvedValue(reply(90, 70)); vi.stubGlobal('fetch', fetch);
  await cachedCriticScores('expiry-fixture', 'tt1234568');
  clock.mockReturnValue(1_000 + 864e5 + 1);
  await cachedCriticScores('expiry-fixture', 'tt1234568');
  await cachedCriticScores('another-fixture', 'tt1234568');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('allows a retry after a failed request', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(reply(95, 85)); vi.stubGlobal('fetch', fetch);
  await expect(cachedCriticScores('retry-fixture', 'tt1234569')).rejects.toThrow('Couldn’t reach OMDb');
  await expect(cachedCriticScores('retry-fixture', 'tt1234569')).resolves.toEqual({ rt: 95, metacritic: 85 });
  expect(fetch).toHaveBeenCalledTimes(2);
});
