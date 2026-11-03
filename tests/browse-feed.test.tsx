import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Discover from '../src/components/browse/Discover';
import { getCatalog } from '../src/services/tmdb';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { Profile } from '../src/types/media';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/db');
vi.mock('../src/services/tmdb', () => ({ setApiKey: vi.fn(), getCatalog: vi.fn(), getCatalogDetail: vi.fn(), getCatalogSeason: vi.fn() }));
vi.mock('../src/services/browse', () => ({ cancelSourceBrowser: vi.fn(), validateSourceUrl: vi.fn(), quickTorrent: vi.fn(), browseSource: vi.fn() }));
let counter = 0;
class Observer {
  static all: Observer[] = [];
  connected = false;
  constructor(private callback: IntersectionObserverCallback) { Observer.all.push(this); }
  observe() { this.connected = true; }
  disconnect() { this.connected = false; }
  enter() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}
const title = (id: number, name = `Title ${id}`) => ({ id, title: name, kind: 'movie' as const, year: 2024, overview: '', poster: null, backdrop: null, voteAverage: 0 });
beforeEach(() => {
  vi.resetAllMocks(); Observer.all = [];
  vi.stubGlobal('IntersectionObserver', Observer);
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState((s) => ({ activeProfile: { id: 1, name: 'Adult', maturity: 'all' } as Profile,
    settings: { ...s.settings, tmdb_api_key: `fixture-${++counter}` } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sentinel = async () => { await waitFor(() => expect(Observer.all.some((o) => o.connected)).toBe(true)); return Observer.all.findLast((o) => o.connected)!; };

it('loads the next page once at the bottom and stops at the last page', async () => {
  let finish!: (result: Awaited<ReturnType<typeof getCatalog>>) => void;
  vi.mocked(getCatalog).mockResolvedValueOnce({ items: [title(1)], pages: 2 })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<Discover />);
  await screen.findByRole('button', { name: 'View Title 1' });
  const bottom = await sentinel();
  act(() => { bottom.enter(); bottom.enter(); bottom.enter(); });
  expect(getCatalog).toHaveBeenCalledTimes(2);
  expect(getCatalog).toHaveBeenLastCalledWith('movie', 'trending', 2, '');
  await act(async () => finish({ items: [title(1), title(2)], pages: 2 }));
  expect(screen.getAllByRole('button', { name: 'View Title 1' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'View Title 2' })).toBeTruthy();
  act(() => bottom.enter());
  expect(getCatalog).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
});

it('keeps loaded cards after an error and retries the failed page without skipping it', async () => {
  vi.mocked(getCatalog).mockResolvedValueOnce({ items: [title(1)], pages: 3 })
    .mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ items: [title(2)], pages: 3 });
  render(<Discover />);
  await screen.findByRole('button', { name: 'View Title 1' });
  const bottom = await sentinel(); act(() => bottom.enter());
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'View Title 1' })).toBeTruthy();
  act(() => bottom.enter()); expect(getCatalog).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('button', { name: 'View Title 2' });
  expect(vi.mocked(getCatalog).mock.calls.map((args) => args[2])).toEqual([1, 2, 2]);
});

it('ignores an old page response after the search changes', async () => {
  let finish!: (result: Awaited<ReturnType<typeof getCatalog>>) => void;
  vi.mocked(getCatalog).mockResolvedValueOnce({ items: [title(1)], pages: 3 })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ items: [title(4, 'New search')], pages: 1 });
  render(<Discover />);
  await screen.findByRole('button', { name: 'View Title 1' });
  const bottom = await sentinel(); act(() => bottom.enter());
  fireEvent.change(screen.getByRole('textbox', { name: 'Search titles to browse' }), { target: { value: 'new query' } });
  await screen.findByRole('button', { name: 'View New search' });
  await act(async () => finish({ items: [title(3, 'Late old page')], pages: 3 }));
  expect(screen.queryByRole('button', { name: 'View Late old page' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'View Title 1' })).toBeNull();
});

it('stops automatic requests when the API returns an empty page', async () => {
  vi.mocked(getCatalog).mockResolvedValueOnce({ items: [title(1)], pages: 20 }).mockResolvedValueOnce({ items: [], pages: 20 });
  render(<Discover />);
  await screen.findByRole('button', { name: 'View Title 1' });
  const bottom = await sentinel(); act(() => bottom.enter());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  act(() => bottom.enter()); expect(getCatalog).toHaveBeenCalledTimes(2);
});

it('keeps the last cached first page visible if refreshing it fails', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  vi.mocked(getCatalog).mockResolvedValueOnce({ items: [title(1)], pages: 1 }).mockRejectedValueOnce(new Error('Offline'));
  const first = render(<Discover />);
  await screen.findByRole('button', { name: 'View Title 1' });
  first.unmount();
  clock.mockReturnValue(1_000 + 16 * 60_000);
  render(<Discover />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'View Title 1' })).toBeTruthy();
  expect(screen.getByText(/Showing saved titles/)).toBeTruthy();
  expect(getCatalog).toHaveBeenCalledTimes(2);
});
