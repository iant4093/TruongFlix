import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import * as db from '../src/services/db';
import { pollTorrents, reconcileTorrentList, torrentForItem } from '../src/services/torrents';
import { createReloadThrottle } from '../src/services/libraryReload';
import { patchProgress, useLibraryStore } from '../src/store/useLibraryStore';
import { buildItems, groupEpisodes } from '../src/store/selectors';
import type { EpisodeRow, MovieRow, SeriesRow } from '../src/types/media';
import { movie, torrentItem, torrentRecord, torrentStatus } from './fixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/db', async (orig) => ({ ...(await orig<typeof import('../src/services/db')>()), listTorrentRecords: vi.fn(), loadLibrary: vi.fn(), listCollections: vi.fn(), updateTorrentRecord: vi.fn() }));
vi.mock('../src/services/enrich', () => ({ startBackgroundAnalysis: vi.fn() }));
vi.mock('../src/services/player', () => ({ play: vi.fn() }));

beforeEach(() => {
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  vi.mocked(db.listCollections).mockResolvedValue([]);
});

it('keeps the torrents array and record identities when a poll changes nothing', async () => {
  const record = torrentRecord({ completed_at: '2026-10-02T00:00:00.000Z' });
  const live = [torrentStatus()];
  vi.mocked(db.loadLibrary).mockResolvedValue({ movies: [movie], series: [], episodes: [] });
  vi.mocked(db.listTorrentRecords).mockImplementation(async () => [{ ...record }]);
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'torrent_list' ? live.map((l) => ({ ...l, files: l.files.map((f) => ({ ...f })) })) : (undefined as never)));
  useLibraryStore.setState({ movies: [movie] });
  await pollTorrents();
  const first = useLibraryStore.getState().torrents;
  const spy = vi.fn();
  const unsub = useLibraryStore.subscribe(spy);
  await pollTorrents();
  unsub();
  expect(useLibraryStore.getState().torrents).toBe(first);
  expect(spy).not.toHaveBeenCalled();

  live[0].upload_speed_bps = 2048;
  await pollTorrents();
  const next = useLibraryStore.getState().torrents;
  expect(next).not.toBe(first);
  expect(next[0].uploadSpeedBps).toBe(2048);
});

it('reuses unchanged records and replaces changed ones', () => {
  const a = torrentItem({ infoHash: 'a' });
  const b = torrentItem({ infoHash: 'b' });
  const prev = [a, b];
  expect(reconcileTorrentList(prev, [{ ...a, files: a.files.map((f) => ({ ...f })) }, { ...b }])).toBe(prev);
  const out = reconcileTorrentList(prev, [{ ...a }, { ...b, progressPct: 50 }]);
  expect(out[0]).toBe(a);
  expect(out[1]).not.toBe(b);
  expect(reconcileTorrentList(prev, [{ ...a }])).toEqual([a]);
});

it('finds the first matching torrent for an item, like a linear scan', () => {
  const [item] = buildItems([{ ...movie, tmdb_id: 7 } as MovieRow], [], new Map());
  const byTmdb = torrentItem({ infoHash: 'tmdb', movieId: null, filePaths: [], tmdbId: 7 });
  const byId = torrentItem({ infoHash: 'id', movieId: 1, filePaths: [] });
  expect(torrentForItem(item, [byTmdb, byId])).toBe(byTmdb);
  expect(torrentForItem(item, [byId, byTmdb])).toBe(byId);
  expect(torrentForItem(item, [torrentItem({ infoHash: 'x', movieId: 99, filePaths: [] })])).toBeNull();
});

it('patches one movie card in place without rebuilding the others', () => {
  const other = { ...movie, id: 2, title: 'Other', file_path: '/Movies/Other.mp4' } as MovieRow;
  const movies = [{ ...movie, progress_seconds: 0 } as MovieRow, other];
  const items = buildItems(movies, [], new Map());
  useLibraryStore.setState({ movies, items, allItems: items });
  patchProgress('movie', 1, 120, 1000);
  const s = useLibraryStore.getState();
  expect(s.items[0].progressSeconds).toBe(120);
  expect(s.items[0].lastWatchedAt).not.toBeNull();
  expect(s.items[1]).toBe(items[1]);
  patchProgress('movie', 1, 10, 1000, true);
  expect(useLibraryStore.getState().items[0].watched).toBe(true);
});

it('patches an episode and its series continue-watching fields', () => {
  const show = { id: 5, tmdb_id: 0, title: 'Show', last_watched_at: null, genres: '[]', cast_crew: '[]' } as unknown as SeriesRow;
  const ep = { id: 9, series_id: 5, season_number: 1, episode_number: 1, title: 'Pilot', file_path: '/TV/1.mkv', progress_seconds: 0, duration_seconds: 0, watched: 0, last_watched_at: null } as unknown as EpisodeRow;
  const grouped = groupEpisodes([ep]);
  const items = buildItems([], [show], grouped);
  useLibraryStore.setState({ series: [show], episodes: [ep], episodesBySeries: grouped, items, allItems: items });
  patchProgress('episode', 9, 300, 1200);
  const s = useLibraryStore.getState();
  expect(s.episodesBySeries.get(5)![0].progress_seconds).toBe(300);
  expect(s.series[0].last_watched_at).not.toBeNull();
  expect(s.items[0].lastWatchedAt).toBe(s.series[0].last_watched_at);
});

it('throttles reloads to one per interval plus a final flush', async () => {
  vi.useFakeTimers();
  const reload = vi.fn(async () => {});
  const t = createReloadThrottle(2000, reload);
  for (let i = 0; i < 10; i++) t.request();
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 10; i++) t.request();
  await vi.advanceTimersByTimeAsync(1000);
  expect(reload).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reload).toHaveBeenCalledTimes(2);
  t.request();
  await t.flush();
  expect(reload).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5000);
  expect(reload).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
});
