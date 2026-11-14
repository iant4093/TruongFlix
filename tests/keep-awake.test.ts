import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false }) }));

import { disposePlayerEvents, initPlayerEvents, isPlayingVideo } from '../src/services/player';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { useLiveStore } from '../src/services/live';
import type { BuiltinPlayerState, PlayerSession } from '../src/types/media';

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
const state = (patch: Partial<BuiltinPlayerState>) => ({ loaded: true, paused: false, eof: false, time: 5, duration: 100, ...patch }) as BuiltinPlayerState;
const awakeCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'keep_awake').map(([, args]) => (args as { on: boolean }).on);

beforeEach(async () => {
  invoke.mockClear();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLiveStore.setState({ multiviewState: null });
  await initPlayerEvents();
});
afterEach(() => disposePlayerEvents());

it('keeps the screen awake only while video is playing', () => {
  useLibraryStore.setState({ playerSession: session, playerState: state({ loaded: false }) });
  expect(awakeCalls()).toEqual([]);
  useLibraryStore.setState({ playerState: state({}) });
  useLibraryStore.setState({ playerState: state({ time: 6 }) });
  expect(awakeCalls()).toEqual([true]);
  useLibraryStore.setState({ playerState: state({ paused: true }) });
  expect(awakeCalls()).toEqual([true, false]);
  useLibraryStore.setState({ playerState: state({}) });
  useLibraryStore.setState({ playerState: state({ eof: true }) });
  expect(awakeCalls()).toEqual([true, false, true, false]);
});

it('stays awake through buffering and releases when the player closes', () => {
  useLibraryStore.setState({ playerSession: session, playerState: state({}) });
  useLibraryStore.setState({ playerState: { ...state({}), buffering: true } as BuiltinPlayerState });
  expect(isPlayingVideo()).toBe(true);
  useLibraryStore.setState({ playerSession: null, playerState: null });
  expect(awakeCalls()).toEqual([true, false]);
});

it('counts multiview panes and VLC playback', () => {
  useLibraryStore.setState({
    playerSession: { ...session, multiview: { playlistId: 'p', id: 'c', title: 'A', subtitle: '' } } as unknown as PlayerSession,
    playerState: state({ paused: true }),
  });
  expect(isPlayingVideo()).toBe(false);
  useLiveStore.setState({ multiviewState: { loadId: 'one', paneId: 'b', loaded: true, paused: false, buffering: false, failed: false } });
  expect(isPlayingVideo()).toBe(true);
  useLibraryStore.getState().setPlayback({ active: true, type: 'movie', id: 1, time: 0, length: 0 });
  useLibraryStore.setState({ playerSession: null, playerState: null });
  expect(isPlayingVideo()).toBe(true);
  expect(awakeCalls()).toEqual([true]);
});
