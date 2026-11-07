import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as db from '../src/services/db';
import {
  closeBuiltin,
  disposePlayerEvents,
  goLive,
  initPlayerEvents,
  playLive,
  seekLive,
  setSleepTimer,
} from '../src/services/player';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { useLiveStore, type ChannelMatch } from '../src/services/live';
import type { BuiltinPlayerState, Profile } from '../src/types/media';
import { limitStatus } from '../src/services/limits';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async () => {} }),
}));
vi.mock('../src/services/db');
vi.mock('../src/services/limits', () => ({
  limitStatus: vi.fn(async () => ({ blocked: null, remaining: null })),
  blockedMessage: () => 'Viewing limit reached',
}));

const profile = { id: 1, maturity: 'all', daily_limit: 0, bedtime: '' } as Profile;
const channel = {
  id: 'espn',
  tvgId: 'ESPN.us@HD',
  name: 'ESPN HD',
  group: 'Sports',
  logo: '',
  transport: { url: 'https://example.org/live.m3u8', referrer: 'https://example.org/', userAgent: 'Test' },
};
const playlist = { id: 'one', name: 'One', input: '', channels: [channel], updatedAt: 1, health: {} };
const match: ChannelMatch = { playlist, channel, key: 'one/espn' };
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const state: BuiltinPlayerState = {
  time: 50,
  duration: 0,
  paused: false,
  eof: false,
  buffering: false,
  seeking: false,
  idle: false,
  volume: 100,
  muted: false,
  speed: 1,
  sub_delay: 0,
  audio_delay: 0,
  gamma: null,
  loaded: true,
  seekable_ranges: [{ start: 40, end: 80 }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState({ activeProfile: profile });
  useLiveStore.setState({ playlists: [playlist], playbackError: '' });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'player_status' ? { available: true } : (undefined as never),
  );
  vi.mocked(listen).mockImplementation(async (name, callback) => {
    handlers.set(String(name), callback as never);
    return () => {
      handlers.delete(String(name));
    };
  });
  vi.mocked(db.logLiveViewing).mockResolvedValue(undefined);
  vi.mocked(db.writeLiveData).mockResolvedValue(undefined);
  vi.mocked(db.loadLibrary).mockResolvedValue({ movies: [], series: [], episodes: [] });
  vi.mocked(db.listCollections).mockResolvedValue([]);
  vi.mocked(limitStatus).mockResolvedValue({ blocked: null, remaining: null });
});
afterEach(() => {
  disposePlayerEvents();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('opens live sources with their headers and a distinct session, without library resume or subtitles', async () => {
  await playLive(match);
  expect(useLibraryStore.getState().playerSession?.target).toEqual({
    type: 'live',
    id: 'espn',
    playlistId: 'one',
    label: 'ESPN HD',
  });
  expect(invoke).toHaveBeenCalledWith(
    'player_open',
    expect.objectContaining({
      filePath: channel.transport.url,
      liveSource: channel.transport,
      startTime: 0,
      subtitlePath: null,
    }),
  );
  expect(db.getSelectedSubtitlePath).not.toHaveBeenCalled();
  expect(db.recordProgress).not.toHaveBeenCalled();
});

it('counts live viewing separately and ignores stale player events', async () => {
  await initPlayerEvents();
  await playLive(match);
  const loadId = useLibraryStore.getState().playerSession!.loadId;
  handlers.get('player-state')!({ payload: { ...state, load_id: 'old-session' } });
  expect(useLibraryStore.getState().playerState).toBeNull();
  for (let i = 0; i < 8; i++) {
    vi.setSystemTime(Date.now() + 1000);
    handlers.get('player-state')!({ payload: { ...state, time: 50 + i, load_id: loadId } });
    await Promise.resolve();
  }
  await closeBuiltin();
  expect(db.logLiveViewing).toHaveBeenCalled();
  expect(db.logWatchTime).not.toHaveBeenCalled();
  expect(db.recordProgress).not.toHaveBeenCalled();
});

it('clamps live seeks to real cache ranges and goes to the buffered live edge', async () => {
  await playLive(match);
  useLibraryStore.setState({ playerState: state });
  await seekLive(-30);
  expect(invoke).toHaveBeenCalledWith('player_command', { args: ['seek', '40', 'absolute+exact'] });
  await seekLive(100);
  expect(invoke).toHaveBeenCalledWith('player_command', { args: ['seek', '80', 'absolute+exact'] });
  await goLive();
  expect(invoke).toHaveBeenCalledWith('player_command', { args: ['seek', '79', 'absolute+exact'] });
  expect(invoke).toHaveBeenLastCalledWith('player_set', { name: 'pause', value: 'no' });
});

it('does not seek when no live buffer is available', async () => {
  await playLive(match);
  vi.mocked(invoke).mockClear();
  useLibraryStore.setState({ playerState: { ...state, seekable_ranges: [] } });
  await seekLive(-10);
  expect(invoke).not.toHaveBeenCalledWith('player_command', expect.anything());
});

it('reconnects Go Live after a long pause leaves the cached edge stale', async () => {
  await playLive(match);
  vi.mocked(invoke).mockClear();
  useLibraryStore.setState({ playerState: { ...state, cache_updated_at: Date.now() - 60_000 } });
  await goLive();
  expect(invoke).toHaveBeenCalledWith('player_open', expect.objectContaining({ liveSource: channel.transport }));
  expect(invoke).not.toHaveBeenCalledWith(
    'player_command',
    expect.objectContaining({ args: ['seek', '79', 'absolute+exact'] }),
  );
});

it.each(['limit', 'bedtime'] as const)('blocks both buffered and stale Go Live while the %s prompt is shown', async (prompt) => {
  await playLive(match);
  vi.mocked(invoke).mockClear();
  useLibraryStore.setState({ playerState: state, playerPrompt: prompt });
  await goLive();
  useLibraryStore.setState({ playerState: { ...state, cache_updated_at: Date.now() - 60_000 } });
  await goLive();
  expect(invoke).not.toHaveBeenCalledWith('player_command', expect.anything());
  expect(invoke).not.toHaveBeenCalledWith('player_set', { name: 'pause', value: 'no' });
  expect(invoke).not.toHaveBeenCalledWith('player_open', expect.anything());
});

it('keeps a channel paused when a viewing limit appears during a live-edge seek', async () => {
  await playLive(match);
  useLibraryStore.setState({ playerState: state });
  let finishSeek!: () => void;
  vi.mocked(invoke).mockImplementation(async (command) => command === 'player_command'
    ? new Promise<void>((resolve) => { finishSeek = resolve; })
    : undefined as never);
  const goingLive = goLive();
  useLibraryStore.setState({ playerPrompt: 'limit' });
  finishSeek();
  await goingLive;
  expect(invoke).not.toHaveBeenCalledWith('player_set', { name: 'pause', value: 'no' });
});

it('does not clear a new channel when an earlier close finishes late', async () => {
  await playLive(match);
  let resolveClose!: () => void;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'player_close'
      ? new Promise<void>((resolve) => {
          resolveClose = resolve;
        })
      : (undefined as never),
  );
  const closing = closeBuiltin();
  expect(useLibraryStore.getState().playerSession).toBeNull();
  await vi.waitFor(() => expect(resolveClose).toBeTypeOf('function'));
  const next = { ...match, channel: { ...channel, id: 'next', name: 'Next feed' }, key: 'one/next' };
  const opening = playLive(next);
  await vi.waitFor(() => expect(useLibraryStore.getState().playerSession?.target.id).toBe('next'));
  resolveClose();
  await Promise.all([closing, opening]);
  expect(useLibraryStore.getState().playerSession?.target.id).toBe('next');
});

it('returns to the library immediately when a channel is still opening', async () => {
  let resolveOpen!: () => void;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'player_status' ? { available: true } : command === 'player_open'
      ? new Promise<void>((resolve) => { resolveOpen = resolve; })
      : (undefined as never),
  );
  const opening = playLive(match);
  await vi.waitFor(() => expect(resolveOpen).toBeTypeOf('function'));
  const closing = closeBuiltin();
  expect(useLibraryStore.getState().playerSession).toBeNull();
  expect(useLibraryStore.getState().playerMini).toBe(false);
  resolveOpen();
  await Promise.all([opening, closing]);
  expect(invoke).toHaveBeenCalledWith('player_close');
  expect(useLibraryStore.getState().playerSession).toBeNull();
});

it('preserves a movie resume point while its close saves in the background', async () => {
  useLibraryStore.setState({
    playerSession: { loadId: 'movie', target: { type: 'movie', id: 42, filePath: '/movie.mp4', label: 'Movie', startTime: 0 }, title: 'Movie', subtitle: null, itemKey: null, overview: null, logo: null, next: null, nextLabel: null },
    playerState: { ...state, duration: 120 },
  });
  let resolveSave!: () => void;
  vi.mocked(db.recordProgress).mockImplementation(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
  const closing = closeBuiltin();
  expect(useLibraryStore.getState().playerSession).toBeNull();
  expect(db.recordProgress).toHaveBeenCalledWith('movie', 42, 50, 120);
  resolveSave();
  await closing;
  expect(invoke).toHaveBeenCalledWith('player_close');
});

it('keeps a live session open after stream failure so retry remains available', async () => {
  await initPlayerEvents();
  await playLive(match);
  const loadId = useLibraryStore.getState().playerSession!.loadId;
  handlers.get('player-error')!({ payload: { load_id: loadId, message: 'Connection failed' } });
  expect(useLibraryStore.getState().playerSession?.target.type).toBe('live');
  expect(useLiveStore.getState().playbackError).toBeTruthy();
});

it('blocks unrated live channels on restricted profiles', async () => {
  useLibraryStore.setState({ activeProfile: { ...profile, maturity: 'kids' } });
  await playLive(match);
  expect(invoke).not.toHaveBeenCalledWith('player_open', expect.anything());
  expect(useLibraryStore.getState().playerSession).toBeNull();
});

it.each(['limit', 'bedtime'] as const)('honours the profile %s before opening a live source', async (blocked) => {
  vi.mocked(limitStatus).mockResolvedValue({ blocked, remaining: 0 });
  await playLive(match);
  expect(invoke).not.toHaveBeenCalledWith('player_open', expect.anything());
});

it('fades and pauses live TV when its sleep timer expires', async () => {
  await playLive(match);
  useLibraryStore.setState({ playerState: state });
  setSleepTimer(1);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(useLibraryStore.getState().playerPrompt).toBe('sleep-ended');
  expect(useLibraryStore.getState().sleepTimer).toBeNull();
  expect(invoke).toHaveBeenCalledWith('player_set', { name: 'pause', value: 'yes' });
  expect(useLibraryStore.getState().playerSession?.target.type).toBe('live');
});
