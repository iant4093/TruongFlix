import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import HoverPreview from '../src/components/home/HoverPreview';
import { extractFrames } from '../src/services/frames';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { buildItems } from '../src/store/selectors';
import { movie } from './fixtures';

vi.mock('../src/services/frames', () => ({ extractFrames: vi.fn().mockResolvedValue(undefined), cancelFrames: vi.fn() }));
vi.mock('../src/services/player', () => ({ playItem: vi.fn() }));
vi.mock('../src/services/torrents', () => ({ torrentForItem: vi.fn().mockReturnValue(null), downloadBlockingPlayback: () => null, canStreamTorrent: () => false, formatDownloadingLabel: vi.fn(), formatExpiryRemaining: vi.fn(), formatSpeed: vi.fn(), keepStreamPermanently: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  const item = buildItems([movie], [], new Map())[0];
  useLibraryStore.setState({ movies: [movie], items: [item], hover: { item, rect: { top: 200, left: 50, width: 200, height: 120 } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('extracts preview frames for newly added titles without duration metadata', async () => {
  render(<HoverPreview />);
  await act(async () => { await vi.advanceTimersByTimeAsync(701); });
  expect(extractFrames).toHaveBeenCalledWith(expect.objectContaining({ path: movie.file_path, times: [5, 15, 30, 45, 60], lane: 'stills' }), expect.any(Function));
});

it('does not decode stills when hover previews are disabled', async () => {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, hover_stills: false } }));
  render(<HoverPreview />);
  await act(async () => { await vi.advanceTimersByTimeAsync(701); });
  expect(extractFrames).not.toHaveBeenCalled();
});
