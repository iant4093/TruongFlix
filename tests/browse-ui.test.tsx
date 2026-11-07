import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import Discover from '../src/components/browse/Discover';
import CatalogTitle from '../src/components/browse/CatalogTitle';
import DetailModal from '../src/components/modals/DetailModal';
import { useLibraryStore } from '../src/store/useLibraryStore';
import * as tmdb from '../src/services/tmdb';
import { getSeasonCache, listSavedBrowseTitles, setSavedBrowseTitle } from '../src/services/db';
import { browseSource, quickTorrent, searchTorrentReleases } from '../src/services/browse';
import SourceBrowser from '../src/components/browse/SourceBrowser';
import type { CatalogDetail, SavedBrowseTitle } from '../src/types/browse';
import type { MediaItem, Profile } from '../src/types/media';
import { cachedCriticScores } from '../src/services/omdb';
vi.mock('../src/services/omdb', () => ({ cachedCriticScores: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/db');
vi.mock('../src/services/tmdb', () => ({ setApiKey: vi.fn(), getCatalog: vi.fn(), getCatalogDetail: vi.fn(), getCatalogSeason: vi.fn(), getSeasonEpisodes: vi.fn(async () => new Map()), resize: (src: string | null) => src }));
vi.mock('../src/services/browse', () => ({ quickTorrent: vi.fn(), searchTorrentReleases: vi.fn(), browseSource: vi.fn(), cancelSourceBrowser: vi.fn(), validateSourceUrl: (s: string) => new URL(s).origin }));
const item = { id: 1, kind: 'tv' as const, title: 'Example', year: 2024, overview: 'A series.', poster: null, backdrop: null, voteAverage: 8 };
const detail: CatalogDetail = { ...item, imdbId: 'tt1234567', certification: 'TV-14', genres: [], runtime: null,
  status: 'Ended', seasons: [{ number: 1, name: 'Season 1', count: 2, airDate: '2024-01-01' }], nextSeason: null, lastSeason: 1, lastEpisode: 2 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listSavedBrowseTitles).mockResolvedValue([]);
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

const librarySeries = { ...item, id: 40, tmdbId: item.id, key: 'tv-40', cast: [], genres: [], versions: [],
  imdbSeasons: {}, matched: true, tmdbSeasons: 2, tech: {} } as unknown as MediaItem;

function LibraryGapFlow() {
  const view = useLibraryStore((state) => state.view);
  return view === 'browse' ? <Discover /> : <DetailModal />;
}

it('opens a missing episode, compares that exact release scope and reopens the saved selection', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  let persisted: SavedBrowseTitle[] = [];
  vi.mocked(listSavedBrowseTitles).mockImplementation(async () => persisted);
  vi.mocked(setSavedBrowseTitle).mockImplementation(async (_, title) => { persisted = [title]; });
  vi.mocked(searchTorrentReleases).mockResolvedValue([]);
  vi.mocked(getSeasonCache).mockResolvedValue([{ season_number: 2, fetched_at: '2024-01-01',
    episodes: JSON.stringify([{ episode_number: 5, name: 'Missing episode', overview: '', air_date: '2024-01-01' }]) }]);
  vi.mocked(tmdb.getCatalogDetail).mockResolvedValue({ ...detail, seasons: [
    ...detail.seasons, { number: 2, name: 'Season 2', count: 5, airDate: '2024-01-01' },
  ] });
  vi.mocked(tmdb.getCatalogSeason).mockResolvedValue({ complete: true, episodes: [1, 5].map((episode_number) => ({
    tmdb_episode_id: episode_number, season_number: 2, episode_number, title: `Episode ${episode_number}`,
    overview: '', air_date: '2024-01-01', runtime: 40, still_path: null,
  })) });
  useLibraryStore.setState({ items: [librarySeries], detailKey: librarySeries.key });
  render(<LibraryGapFlow />);
  fireEvent.click(screen.getByRole('button', { name: 'Season' }));
  fireEvent.click(screen.getByRole('option', { name: /Season 2/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Find Season 2, Episode 5, Missing episode/ }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Compare releases' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole('button', { name: 'Choose season' }).textContent).toContain('Season 2');
  expect(screen.getByRole('button', { name: 'Choose episode or entire season' }).textContent).toContain('Episode 5');
  fireEvent.click(screen.getByRole('button', { name: 'Compare releases' }));
  fireEvent.click(screen.getByRole('button', { name: '4K' }));
  expect(searchTorrentReleases).toHaveBeenCalledWith(expect.objectContaining({
    target: expect.objectContaining({ kind: 'episode', season: 2, episode: 5, quality: '4K' }),
  }));
  const saveButton = screen.getByRole('button', { name: 'Save S02 · E05 to Browse' });
  fireEvent.click(saveButton);
  await waitFor(() => expect(saveButton.getAttribute('aria-pressed')).toBe('true'));
  expect(persisted[0]?.selection).toEqual({ season: 2, episode: 5 });
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Saved in Browse' }));
  fireEvent.click(await screen.findByRole('button', { name: 'View Example' }));
  expect(screen.getByRole('button', { name: 'Choose episode or entire season' }).textContent).toContain('Episode 5');
});

it('uses the missing franchise movie’s TMDB ID rather than the open Library movie’s ID', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  const owned = { ...librarySeries, kind: 'movie', tmdbId: 10, title: 'First Film', collectionId: 12 };
  const missing = { id: 11, kind: 'movie' as const, title: 'Second Film', year: 2024, releaseDate: '2024-01-01',
    overview: '', poster: null, backdrop: null, voteAverage: 0 };
  vi.mocked(tmdb.getCatalogDetail).mockResolvedValue({ ...detail, ...missing, seasons: [] });
  useLibraryStore.setState({
    detailKey: owned.key, items: [owned],
    collections: [{ id: 12, name: 'Films', overview: null, poster_path: null, backdrop_path: null, fetched_at: null,
      parts: JSON.stringify([{ tmdb_id: 10, title: owned.title }, { ...missing, tmdb_id: missing.id, release_date: missing.releaseDate }]) }],
  });
  render(<LibraryGapFlow />);
  fireEvent.click(screen.getByRole('button', { name: 'Find Second Film in Browse' }));
  await screen.findByRole('dialog', { name: 'Second Film' });
  expect(tmdb.getCatalogDetail).toHaveBeenCalledWith(missing);
});

it('applies the parental PIN to direct Settings and magnet entry points', async () => {
  const adult = { id: 1, name: 'Adult', maturity: 'all', pin: '1234' } as Profile;
  const child = { id: 2, name: 'Child', maturity: 'kids' } as Profile;
  useLibraryStore.setState({ profiles: [adult, child], activeProfile: child });
  useLibraryStore.getState().setSettingsOpen(true, 'library');
  expect(useLibraryStore.getState().settingsOpen).toBe(false);
  expect(await useLibraryStore.getState().pinRequest?.check('0000')).toBe(false);
  const approval = useLibraryStore.getState().pinRequest!;
  expect(await approval.check('1234')).toBe(true);
  approval.then();
  expect(useLibraryStore.getState().settingsOpen).toBe(true);

  useLibraryStore.getState().openAddTorrent('magnet:?xt=urn:btih:test');
  expect(useLibraryStore.getState().addTorrentModal).toBeNull();
  const staleApproval = useLibraryStore.getState().pinRequest!;
  useLibraryStore.setState({ activeProfile: adult });
  staleApproval.then();
  expect(useLibraryStore.getState().addTorrentModal).toBeNull();
});

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

it('compares the selected quality and keeps the chosen release tied to its exact episode', async () => {
  const release = { id: '17', imdbId: detail.imdbId, title: 'Example.S01E02.2160p.WEB', seeders: 320, size: '3 GB' };
  vi.mocked(searchTorrentReleases).mockResolvedValue([release]);
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  const episode = await screen.findByRole('button', { name: 'Choose episode or entire season' });
  fireEvent.click(episode);
  fireEvent.click(screen.getByRole('option', { name: /Episode 2/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Compare releases' }));
  fireEvent.click(screen.getByRole('button', { name: '4K' }));
  const pick = await screen.findByRole('button', { name: `Download ${release.title}` });
  expect(searchTorrentReleases).toHaveBeenCalledWith(expect.objectContaining({
    target: expect.objectContaining({ kind: 'episode', season: 1, episode: 2, quality: '4K' }),
  }));
  expect(quickTorrent).not.toHaveBeenCalled();
  expect(screen.getByText(/320 reported seeds · 3 GB/)).toBeTruthy();
  fireEvent.click(pick);
  await waitFor(() => expect(quickTorrent).toHaveBeenCalledWith(expect.objectContaining({
    release, mode: 'download', target: expect.objectContaining({ kind: 'episode', episode: 2, quality: '4K' }),
  })));
  await waitFor(() => expect((episode as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(episode);
  fireEvent.click(screen.getByRole('option', { name: /Episode 1/ }));
  expect(screen.queryByRole('button', { name: `Download ${release.title}` })).toBeNull();
});

it('moves focus into the picker and restores it after canceling and closing', async () => {
  vi.mocked(searchTorrentReleases).mockImplementation(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
  }));
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByRole('button', { name: 'Choose episode or entire season' });
  const trigger = screen.getByRole('button', { name: 'Compare releases' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '1080p' }));
  const quality = screen.getByRole('button', { name: '4K' });
  fireEvent.click(quality);
  const cancel = screen.getByRole('button', { name: 'Cancel search' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  await waitFor(() => expect(document.activeElement).toBe(quality));
  fireEvent.click(screen.getByRole('button', { name: 'Close release picker' }));
  expect(document.activeElement).toBe(trigger);
});

it('lists every episode for Entire season while keeping the quick action scoped to the pack', async () => {
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  const picker = await screen.findByRole('button', { name: 'Choose episode or entire season' });
  const episodes = within(screen.getByRole('list', { name: 'Season 1 episodes' }));
  expect(episodes.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['1. Episode 1']);
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole('option', { name: /Entire season/ }));
  expect(episodes.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['1. Episode 1', '2. Episode 2']);
  fireEvent.click(screen.getByRole('button', { name: /Quick stream/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Download 1080p' }));
  expect(quickTorrent).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'download',
    target: expect.objectContaining({ kind: 'season', season: 1, expected: [1, 2], complete: true, quality: '1080p' }),
  }));
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
  expect(within(screen.getByRole('region', { name: 'Cast' })).getByText('An Actor')).toBeTruthy();
  expect(screen.getByText('Lead')).toBeTruthy();
  expect(screen.getByText('A Creator')).toBeTruthy();
  expect(screen.getByText('A Network')).toBeTruthy();
  expect(screen.getByText('English')).toBeTruthy();
  expect(screen.getByRole('dialog').className).toContain('max-w-4xl');
});

it('uses the library IMDb badge with votes and falls back to TMDB when IMDb is disabled', async () => {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, imdb_enabled: true } }));
  vi.mocked(invoke).mockResolvedValue({ ratings: { [detail.imdbId]: { rating: 9.1, votes: 162_000 } } });
  render(<CatalogTitle item={item} onClose={vi.fn()} onSource={vi.fn()} />);
  const badge = await screen.findByRole('button', { name: /IMDb.*9\.1.*162K/ });
  expect(badge.textContent).toBe('IMDb9.1(162K)');
  expect(screen.queryByText('TMDB')).toBeNull();
  act(() => useLibraryStore.setState((s) => ({ settings: { ...s.settings, imdb_enabled: false } })));
  expect(screen.queryByRole('button', { name: /IMDb/ })).toBeNull();
  expect(screen.getByText('TMDB')).toBeTruthy();
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

it('keeps saved Browse titles across visits and profiles without changing library My List', async () => {
  const persisted = new Map<number, tmdb.SearchResult[]>();
  vi.mocked(listSavedBrowseTitles).mockImplementation(async (profile) => persisted.get(profile) ?? []);
  vi.mocked(setSavedBrowseTitle).mockImplementation(async (profile, title, save) => {
    persisted.set(profile, save ? [title] : []);
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const libraryItem = { ...item, id: 40, tmdbId: item.id, key: 'tv-40', myList: true } as MediaItem;
  useLibraryStore.setState({ items: [libraryItem] });

  const first = render(<Discover />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved in Browse' }));
  await screen.findByText('Save a title from Browse to find it here.');
  expect(screen.queryByRole('button', { name: 'View Example' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
  fireEvent.click(await screen.findByRole('button', { name: 'View Example' }));
  const saveButton = screen.getByRole('button', { name: 'Save to Browse' });
  fireEvent.click(saveButton);
  await waitFor(() => expect(saveButton.getAttribute('aria-pressed')).toBe('true'));
  expect(setSavedBrowseTitle).toHaveBeenCalledWith(1, expect.objectContaining({ id: item.id, kind: 'tv' }), true);
  first.unmount();

  useLibraryStore.setState((state) => ({ settings: { ...state.settings, tmdb_api_key: '' } }));
  render(<Discover />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved in Browse' }));
  await screen.findByRole('button', { name: 'View Example' });

  const originalProfile = useLibraryStore.getState().activeProfile!;
  act(() => useLibraryStore.setState({ activeProfile: { ...originalProfile, id: 2 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Saved in Browse' }));
  await screen.findByText('Save a title from Browse to find it here.');
  expect(screen.queryByRole('button', { name: 'View Example' })).toBeNull();

  act(() => useLibraryStore.setState({ activeProfile: originalProfile }));
  fireEvent.click(screen.getByRole('button', { name: 'Saved in Browse' }));
  fireEvent.click(await screen.findByRole('button', { name: 'View Example' }));
  const removeButton = screen.getByRole('button', { name: 'Save to Browse' });
  expect(removeButton.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(removeButton);
  await waitFor(() => expect(removeButton.getAttribute('aria-pressed')).toBe('false'));
  expect(setSavedBrowseTitle).toHaveBeenLastCalledWith(1, expect.objectContaining({ id: item.id, kind: 'tv' }), false);
  expect(useLibraryStore.getState().items[0].myList).toBe(true);
  vi.mocked(window.scrollTo).mockRestore();
});

it('loads the saved list after a save that was pending when Browse closed', async () => {
  let persisted: tmdb.SearchResult[] = [];
  let completeSave!: () => void;
  vi.mocked(listSavedBrowseTitles).mockImplementation(async () => persisted);
  vi.mocked(setSavedBrowseTitle).mockImplementation((_profile, title) => new Promise((resolve) => {
    completeSave = () => { persisted = [title]; resolve(); };
  }));
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

  try {
    const first = render(<Discover />);
    fireEvent.click(await screen.findByRole('button', { name: 'View Example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to Browse' }));
    expect(setSavedBrowseTitle).toHaveBeenCalledOnce();
    first.unmount();

    render(<Discover />);
    fireEvent.click(screen.getByRole('button', { name: 'Saved in Browse' }));
    await act(async () => {});
    await act(async () => completeSave());
    expect(await screen.findByRole('button', { name: 'View Example' })).toBeTruthy();
  } finally {
    scrollTo.mockRestore();
  }
});
