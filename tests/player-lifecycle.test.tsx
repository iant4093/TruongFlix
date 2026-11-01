import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import PlayerScreen from '../src/components/player/PlayerScreen';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { autoAdvance, closeBuiltin, retuneLive } from '../src/services/player';
import type { BuiltinPlayerState, PlayerSession } from '../src/types/media';
import { useLiveStore } from '../src/services/live';

vi.mock('../src/services/player', () => ({ autoAdvance: vi.fn(), closeBuiltin: vi.fn(), retuneLive: vi.fn(), stopForSleep: () => false }));
vi.mock('../src/services/frames', () => ({ cancelFrames: vi.fn(), extractFrames: vi.fn(), coarseToFine: () => [] }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false }) }));
const session: PlayerSession = {
  loadId: 'one',
  target: { type: 'movie', id: 1, filePath: '/sample.mp4', label: 'Sample', startTime: 0 },
  title: 'Sample',
  subtitle: null,
  itemKey: null,
  overview: null,
  logo: null,
  next: null,
  nextLabel: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLiveStore.setState({ playbackError: '' });
  useLibraryStore.setState({
    playerMini: true,
    playerSession: session,
    playerState: { loaded: true, eof: true, time: 100, duration: 100 } as BuiltinPlayerState,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('cancels an ended movie’s delayed close when a live channel starts', async () => {
  render(<PlayerScreen />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  act(() =>
    useLibraryStore.setState({
      playerSession: {
        loadId: 'live',
        target: { type: 'live', id: 'channel', playlistId: 'source', label: 'Live' },
        title: 'Live',
        subtitle: null,
        itemKey: null,
        overview: null,
        logo: null,
        next: null,
        nextLabel: null,
      },
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(closeBuiltin).not.toHaveBeenCalled();
});

it('allows auto advance after replaying the same library item in a new session', () => {
  useLibraryStore.setState({ playerSession: { ...session, next: { ...session.target, id: 2 } } });
  render(<PlayerScreen />);
  expect(autoAdvance).toHaveBeenCalledTimes(1);
  act(() =>
    useLibraryStore.setState({ playerSession: { ...session, loadId: 'replay', next: { ...session.target, id: 2 } } }),
  );
  expect(autoAdvance).toHaveBeenCalledTimes(2);
});

it('keeps live reconnection active while the mini-player is open', async () => {
  useLibraryStore.setState({ playerSession: { loadId: 'live', target: { type: 'live', id: 'channel', playlistId: 'source', label: 'Live' }, title: 'Live', subtitle: null, itemKey: null, overview: null, logo: null, next: null, nextLabel: null } });
  render(<PlayerScreen />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(retuneLive).toHaveBeenCalledTimes(1);
  expect(closeBuiltin).not.toHaveBeenCalled();
});

it.each([false, true])('allows Back and Escape while a live stream is buffering (loaded=%s)', async (loaded) => {
  useLibraryStore.setState({
    playerMini: false,
    playerSession: { loadId: 'buffering', target: { type: 'live', id: 'channel', playlistId: 'source', label: 'Live' }, title: 'Live', subtitle: null, itemKey: null, overview: null, logo: null, next: null, nextLabel: null },
    playerState: { loaded, buffering: true, eof: false } as BuiltinPlayerState,
  });
  render(<PlayerScreen />);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(screen.getByRole('status', { name: 'Buffering live stream' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Live TV' }));
  expect(closeBuiltin).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.keyDown(window, { code: 'Escape' }); });
  expect(closeBuiltin).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(16_001); });
  expect(screen.getByRole('heading', { name: 'Channel interrupted' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Live TV' }));
  expect(closeBuiltin).toHaveBeenCalledTimes(3);
});
