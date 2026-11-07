import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import DetailModal from '../src/components/modals/DetailModal';
import { autoAdvance, play } from '../src/services/player';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { buildItems } from '../src/store/selectors';
import type { PlayTarget } from '../src/types/media';
import { movie, torrentItem } from './fixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async () => {} }) }));
vi.mock('../src/services/db');
vi.mock('../src/services/omdb', () => ({ cachedCriticScores: vi.fn() }));
vi.mock('../src/services/tmdb', () => ({ getSeasonEpisodes: vi.fn(async () => new Map()), resize: (src: string | null) => src }));
vi.mock('../src/services/limits', () => ({
  limitStatus: vi.fn(async () => ({ blocked: null, remaining: null })),
  blockedMessage: () => 'Viewing limit reached',
}));

const item = buildItems([movie], [], new Map())[0];
const target: PlayTarget = { type: 'movie', id: movie.id, filePath: movie.file_path, startTime: 0, label: 'Sintel' };
const refusal = '“Sintel” is still downloading — it will be playable when the download finishes.';

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState({ movies: [movie], items: [item], torrents: [torrentItem()] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows an unfinished download as downloading instead of offering to stream it', () => {
  useLibraryStore.setState({ detailKey: item.key });
  render(<DetailModal />);
  const button = screen.getByRole('button', { name: /Downloading 42%/ }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.queryByText(/Stream Now|Resume Stream/)).toBeNull();
  expect(screen.queryByTitle('Cast to a TV')).toBeNull();
});

it.each([
  ['a user-chosen stream', { mode: 'stream' as const }],
  ['a promoted stream still in the stream cache', { savePath: '/Permanent/Sintel' }],
])('still offers to stream %s', (_label, patch) => {
  useLibraryStore.setState({ detailKey: item.key, torrents: [torrentItem(patch)] });
  render(<DetailModal />);
  expect((screen.getByRole('button', { name: /Resume Stream/ }) as HTMLButtonElement).disabled).toBe(false);
});

it('plays a finished download normally', () => {
  useLibraryStore.setState({ detailKey: item.key, torrents: [torrentItem({ finished: true, progressPct: 100, state: 'seeding' })] });
  render(<DetailModal />);
  expect((screen.getByRole('button', { name: /^Resume/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/Downloading|Stream Now|Resume Stream/)).toBeNull();
});

it('refuses to start playback of an unfinished download from any entry point', async () => {
  await play(target);
  autoAdvance(target);
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalledWith('torrent_stream_url', expect.anything());
  expect(invoke).not.toHaveBeenCalledWith('launch_vlc', expect.anything());
  expect(useLibraryStore.getState().playerSession).toBeNull();
  expect(useLibraryStore.getState().toasts.map((t) => t.message)).toEqual([refusal, refusal]);
});
