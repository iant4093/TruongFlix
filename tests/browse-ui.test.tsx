import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import Discover from '../src/components/browse/Discover';
import CatalogTitle from '../src/components/browse/CatalogTitle';
import { useLibraryStore } from '../src/store/useLibraryStore';
import * as tmdb from '../src/services/tmdb';
import { browseSource, quickTorrent } from '../src/services/browse';
import SourceBrowser from '../src/components/browse/SourceBrowser';
import type { CatalogDetail } from '../src/types/browse';
import type { Profile } from '../src/types/media';
import { cachedCriticScores } from '../src/services/omdb';
vi.mock('../src/services/omdb', () => ({ cachedCriticScores: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/db');
vi.mock('../src/services/tmdb', () => ({ setApiKey: vi.fn(), getCatalog: vi.fn(), getCatalogDetail: vi.fn(), getCatalogSeason: vi.fn() }));
vi.mock('../src/services/browse', () => ({ quickTorrent: vi.fn(), browseSource: vi.fn(), cancelSourceBrowser: vi.fn(), validateSourceUrl: (s: string) => new URL(s).origin }));
const item = { id: 1, kind: 'tv' as const, title: 'Example', year: 2024, overview: 'A series.', poster: null, backdrop: null, voteAverage: 8 };
const detail: CatalogDetail = { ...item, imdbId: 'tt1234567', certification: 'TV-14', genres: [], runtime: null,
  status: 'Ended', seasons: [{ number: 1, name: 'Season 1', count: 2, airDate: '2024-01-01' }], nextSeason: null, lastSeason: 1, lastEpisode: 2 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState((s) => ({ activeProfile: { id: 1, name: 'Adult', maturity: 'all' } as Profile,
    settings: { ...s.settings, tmdb_api_key: 'test', imdb_enabled: false, browse_source_url: 'https://source.example' } }));
  vi.mocked(tmdb.getCatalog).mockResolvedValue({ pages: 1, items: [item] });
  vi.mocked(tmdb.getCatalogDetail).mockResolvedValue(detail);
  vi.mocked(tmdb.getCatalogSeason).mockResolvedValue({ complete: true, episodes: [1, 2].map((episode_number) => ({
    tmdb_episode_id: episode_number, season_number: 1, episode_number, title: `Episode ${episode_number}`, overview: '', air_date: '2024-01-01', runtime: 40, still_path: null,
  })) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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

it('suspends Browse when the profile selector is open', () => {
  useLibraryStore.setState({ profileGate: 'select' });
  render(<Discover />);
  expect(screen.queryByRole('button', { name: 'Add torrent source' })).toBeNull();
  expect(tmdb.getCatalog).not.toHaveBeenCalled();
});

it('shows fuller title information in a wide library-style dialog', async () => {
  vi.mocked(tmdb.getCatalogDetail).mockResolvedValue({ ...detail, tagline: 'A larger story.', language: 'en', releaseDate: '2024-01-01',
    totalEpisodes: 2, networks: ['A Network'], cast: [{ id: 5, name: 'An Actor', character: 'Lead' }, { id: 6, name: 'A Creator', job: 'Creator' }] });
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByText('A larger story.');
  expect(screen.getByText('An Actor')).toBeTruthy();
  expect(screen.getByText('Lead')).toBeTruthy();
  expect(screen.getByText('A Creator')).toBeTruthy();
  expect(screen.getByText('A Network')).toBeTruthy();
  expect(screen.getByText('English')).toBeTruthy();
  expect(screen.getByRole('dialog').className).toContain('max-w-5xl');
});

it('shows Rotten Tomatoes and Metacritic using the configured OMDb key', async () => {
  useLibraryStore.setState((state) => ({ settings: { ...state.settings, omdb_api_key: 'critic-fixture' } }));
  vi.mocked(cachedCriticScores).mockResolvedValue({ rt: 98, metacritic: 82 });
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByTitle('Rotten Tomatoes: 98% of critics');
  expect(screen.getByTitle('Metacritic: 82/100')).toBeTruthy();
  expect(cachedCriticScores).toHaveBeenCalledWith('critic-fixture', detail.imdbId);
});

it('reuses critic scores already in the library without another request', async () => {
  useLibraryStore.setState({ items: [{ ...item, tmdbId: item.id, rtScore: 0, metacritic: 45 }] as never });
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByTitle('Rotten Tomatoes: 0% of critics');
  expect(screen.getByTitle('Metacritic: 45/100')).toBeTruthy();
  expect(cachedCriticScores).not.toHaveBeenCalled();
});

it('ignores critic results from the old key after the configuration changes', async () => {
  let finish!: (value: { rt: number; metacritic: number }) => void;
  useLibraryStore.setState((state) => ({ settings: { ...state.settings, omdb_api_key: 'old-fixture' } }));
  vi.mocked(cachedCriticScores).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ rt: 80, metacritic: 60 });
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await waitFor(() => expect(cachedCriticScores).toHaveBeenCalledOnce());
  act(() => useLibraryStore.setState((state) => ({ settings: { ...state.settings, omdb_api_key: 'new-fixture' } })));
  await screen.findByTitle('Rotten Tomatoes: 80% of critics');
  await act(async () => finish({ rt: 98, metacritic: 82 }));
  expect(screen.queryByTitle('Rotten Tomatoes: 98% of critics')).toBeNull();
  expect(screen.getByTitle('Metacritic: 60/100')).toBeTruthy();
});

it('browses torrents inside the app and restores the selected episode on return', async () => {
  const control = vi.fn().mockResolvedValue(undefined);
  vi.mocked(browseSource).mockResolvedValue({ requestId: 'manual-fixture', control, close: vi.fn() });
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByRole('button', { name: 'Choose episode or entire season' });
  fireEvent.click(screen.getByRole('button', { name: 'Choose episode or entire season' }));
  fireEvent.click(screen.getByRole('option', { name: /Episode 2/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Browse torrents' }));
  await screen.findByRole('dialog', { name: 'Browse torrents for Example' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Reload source' }) as HTMLButtonElement).disabled).toBe(false));
  for (const name of ['Back one page', 'Forward one page', 'Reload source']) fireEvent.click(screen.getByRole('button', { name }));
  expect(control.mock.calls.map(([action]) => action)).toEqual(['back', 'forward', 'reload']);
  const signal = vi.mocked(browseSource).mock.calls[0][3]!.signal!;
  fireEvent.click(screen.getByRole('button', { name: 'Back to title' }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Choose episode or entire season' }).textContent).toContain('Episode 2');
  expect(screen.queryByRole('dialog', { name: 'Browse torrents for Example' })).toBeNull();
});

it('closes a late source session after the embedded browser was already dismissed', async () => {
  let finish!: (session: Awaited<ReturnType<typeof browseSource>>) => void;
  vi.mocked(browseSource).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<SourceBrowser item={detail} sourceUrl="https://source.example" onBack={vi.fn()} onSelected={vi.fn()} />);
  const signal = vi.mocked(browseSource).mock.calls[0][3]!.signal!;
  expect(screen.getByRole('status').textContent).toContain('Opening your source');
  view.unmount(); expect(signal.aborted).toBe(true);
  const close = vi.fn();
  await act(async () => finish({ requestId: 'late-fixture', control: vi.fn(), close }));
  expect(close).toHaveBeenCalledOnce();
});

it('offers a retry and accessible exit when the embedded source fails to open', async () => {
  vi.mocked(browseSource).mockRejectedValueOnce(new Error('Source unavailable'))
    .mockResolvedValueOnce({ requestId: 'retry-fixture', control: vi.fn(), close: vi.fn() });
  const back = vi.fn();
  render(<SourceBrowser item={detail} sourceUrl="https://source.example" onBack={back} onSelected={vi.fn()} />);
  await screen.findByText('Source unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(browseSource).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Close torrent browser' }));
  expect(back).toHaveBeenCalledOnce();
});
