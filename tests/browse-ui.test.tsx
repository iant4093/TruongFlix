import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Discover from '../src/components/browse/Discover';
import CatalogTitle from '../src/components/browse/CatalogTitle';
import { useLibraryStore } from '../src/store/useLibraryStore';
import * as tmdb from '../src/services/tmdb';
import { quickTorrent } from '../src/services/browse';
import type { CatalogDetail } from '../src/types/browse';
import type { Profile } from '../src/types/media';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/db');
vi.mock('../src/services/tmdb', () => ({ setApiKey: vi.fn(), getCatalog: vi.fn(), getCatalogDetail: vi.fn(), getCatalogSeason: vi.fn() }));
vi.mock('../src/services/browse', () => ({ quickTorrent: vi.fn(), browseSource: vi.fn(), cancelSourceBrowser: vi.fn(), validateSourceUrl: (s: string) => new URL(s).origin }));
const item = { id: 1, kind: 'tv' as const, title: 'Example', year: 2024, overview: 'A series.', poster: null, backdrop: null, voteAverage: 8 };
const detail: CatalogDetail = { ...item, imdbId: 'tt1234567', certification: 'TV-14', genres: [], runtime: null,
  status: 'Ended', seasons: [{ number: 1, name: 'Season 1', count: 2, airDate: '2024-01-01' }], nextSeason: null, lastSeason: 1, lastEpisode: 2 };
beforeEach(() => {
  vi.resetAllMocks();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState((s) => ({ activeProfile: { id: 1, name: 'Adult', maturity: 'all' } as Profile,
    settings: { ...s.settings, tmdb_api_key: 'test', imdb_enabled: false, browse_source_url: 'https://ext.to' } }));
  vi.mocked(tmdb.getCatalog).mockResolvedValue({ pages: 1, items: [item] });
  vi.mocked(tmdb.getCatalogDetail).mockResolvedValue(detail);
  vi.mocked(tmdb.getCatalogSeason).mockResolvedValue({ complete: true, episodes: [1, 2].map((episode_number) => ({
    tmdb_episode_id: episode_number, season_number: 1, episode_number, title: `Episode ${episode_number}`, overview: '', air_date: '2024-01-01', runtime: 40, still_path: null,
  })) });
});
afterEach(cleanup);
it('requires an unrestricted profile before fetching discovery', () => {
  useLibraryStore.setState({ activeProfile: { id: 2, name: 'Child', maturity: 'kids' } as Profile });
  render(<Discover />);
  expect(screen.getByText(/Switch to an unrestricted profile/)).toBeTruthy();
  expect(tmdb.getCatalog).not.toHaveBeenCalled();
});
it('requires TMDB setup without requesting the catalog', () => {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, tmdb_api_key: '' } }));
  render(<Discover />);
  expect(screen.getByRole('button', { name: 'Connect TMDB' })).toBeTruthy();
  expect(tmdb.getCatalog).not.toHaveBeenCalled();
});
it('uses the explicit selected episode and quality for a quick action', async () => {
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByRole('button', { name: 'Choose episode or entire season' });
  fireEvent.click(screen.getByRole('button', { name: 'Choose episode or entire season' }));
  fireEvent.click(screen.getByRole('option', { name: /Episode 2/ }));
  fireEvent.click(screen.getByRole('button', { name: /Quick stream/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Stream 4K' }));
  await waitFor(() => expect(quickTorrent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'stream', target: expect.objectContaining({ kind: 'episode', season: 1, episode: 2, quality: '4K' }) })));
});
it('disables automatic season actions when completeness is uncertain', async () => {
  vi.mocked(tmdb.getCatalogSeason).mockResolvedValue({ complete: false, episodes: [] });
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByRole('button', { name: 'Choose episode or entire season' });
  fireEvent.click(screen.getByRole('button', { name: 'Choose episode or entire season' }));
  fireEvent.click(screen.getByRole('option', { name: /Entire season/ }));
  expect((screen.getByRole('button', { name: /Quick stream/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Browse torrents' }) as HTMLButtonElement).disabled).toBe(false);
});
it('cancels a quick search when the title closes', async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(quickTorrent).mockImplementation((opts) => { signal = opts.signal; return new Promise(() => {}); });
  const view = render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByRole('button', { name: 'Choose episode or entire season' });
  fireEvent.click(screen.getByRole('button', { name: /Quick stream/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Stream 1080p' }));
  await waitFor(() => expect(signal).toBeTruthy());
  act(() => view.unmount());
  expect(signal!.aborted).toBe(true);
});

it('places quick actions above a low trigger outside the scrolling title dialog', async () => {
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 20, y: 700, top: 700, bottom: 744, left: 20, right: 320, width: 300, height: 44, toJSON: () => ({}),
  });
  try {
    render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
    await screen.findByRole('button', { name: 'Choose episode or entire season' });
    fireEvent.click(screen.getByRole('button', { name: /Quick stream/ }));
    const menu = screen.getByRole('menu', { name: 'Quick torrent actions' });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.bottom).toBe(`${window.innerHeight - 700 + 4}px`);
    expect(menu.style.top).toBe('');
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  } finally { bounds.mockRestore(); }
});

it('retains the episode selection while its dialog is suspended for source settings', async () => {
  const close = vi.fn();
  const view = render(<CatalogTitle item={item} onClose={close} onSource={vi.fn()} />);
  await screen.findByRole('button', { name: 'Choose episode or entire season' });
  fireEvent.click(screen.getByRole('button', { name: 'Choose episode or entire season' }));
  fireEvent.click(screen.getByRole('option', { name: /Episode 2/ }));
  view.rerender(<CatalogTitle item={item} onClose={close} onSource={vi.fn()} suspended />);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  view.rerender(<CatalogTitle item={item} onClose={close} onSource={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Choose episode or entire season' }).textContent).toContain('Episode 2');
});
