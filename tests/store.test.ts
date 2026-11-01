import { beforeEach, expect, it, vi } from 'vitest';
import * as db from '../src/services/db';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { movie } from './fixtures';

vi.mock('../src/services/db');

beforeEach(() => {
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  vi.mocked(db.listCollections).mockResolvedValue([]);
});

it('closes a deleted title and its overlays atomically with the library reload', async () => {
  useLibraryStore.setState({ detailKey: 'movie-1', detailEpisodeId: 2, fixMatchKey: 'movie-1' });
  vi.mocked(db.loadLibrary).mockResolvedValue({ movies: [], series: [], episodes: [] });
  const updates: { key: string | null; count: number }[] = [];
  const unsubscribe = useLibraryStore.subscribe((s) => updates.push({ key: s.detailKey, count: s.items.length }));
  await useLibraryStore.getState().reload();
  unsubscribe();
  expect(updates).toEqual([{ key: null, count: 0 }]);
  expect(useLibraryStore.getState().detailEpisodeId).toBeNull();
  expect(useLibraryStore.getState().fixMatchKey).toBeNull();
});

it('keeps an existing title open during background reloads', async () => {
  useLibraryStore.setState({ detailKey: 'movie-1' });
  vi.mocked(db.loadLibrary).mockResolvedValue({ movies: [movie], series: [], episodes: [] });
  await useLibraryStore.getState().reload();
  expect(useLibraryStore.getState().detailKey).toBe('movie-1');
});
