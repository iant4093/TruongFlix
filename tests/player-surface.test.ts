import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { BuiltinPlayerState, PlayTarget } from '../src/types/media';
import { movie } from './fixtures';

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const fullscreenCalls: boolean[] = [];
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => {
    handlers.set(name, fn);
    return () => handlers.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async (on: boolean) => void fullscreenCalls.push(on) }),
}));
vi.mock('../src/services/db');
vi.mock('../src/services/limits', () => ({
  limitStatus: vi.fn(async () => ({ blocked: null, remaining: null })),
  blockedMessage: () => '',
  startLimitWatch: vi.fn(),
}));

const { disposePlayerEvents, initPlayerEvents, playBuiltin, toggleFullscreen, videoShowing } = await import('../src/services/player');
const { createResizeSettle, resizeSettle, SETTLE_FIRST_RESIZE_MS, SETTLE_MAX_MS, SETTLE_QUIET_MS } = await import('../src/services/resizeSettle');

const target: PlayTarget = { type: 'movie', id: movie.id, filePath: movie.file_path, startTime: 0, label: 'Sintel' };
const surface = () => document.documentElement.classList.contains('player-surface');
const state = (patch: Partial<BuiltinPlayerState>): BuiltinPlayerState => ({
  time: 0, duration: 0, paused: false, eof: false, buffering: false, seeking: false, idle: false, volume: 100, muted: false,
  speed: 1, sub_delay: 0, audio_delay: 0, gamma: null, loaded: false, ...patch,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the page over the video at playback start', () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    document.documentElement.classList.remove('player-surface');
    useLibraryStore.setState(useLibraryStore.getInitialState(), true);
    useLibraryStore.setState({ movies: [movie] });
    await initPlayerEvents();
  });
  afterEach(() => {
    disposePlayerEvents();
    vi.useRealTimers();
  });

  it('stays opaque until the video’s first frame is on screen', async () => {
    await playBuiltin(target);
    expect(invoke).toHaveBeenCalledWith('player_open', expect.anything());
    // The video window exists, but nothing has been drawn in it yet (it would show the library).
    expect(surface()).toBe(false);
    const loadId = useLibraryStore.getState().playerSession!.loadId;
    handlers.get('player-state')!({ payload: state({ load_id: loadId, loaded: true }) });
    expect(surface()).toBe(false);
    handlers.get('player-state')!({ payload: state({ load_id: 'an older file', loaded: true, rendered: true }) });
    expect(surface()).toBe(false);
    handlers.get('player-state')!({ payload: state({ load_id: loadId, loaded: true, rendered: true }) });
    expect(surface()).toBe(true);
  });

  it('turns transparent anyway if no frame is ever reported', async () => {
    vi.useFakeTimers();
    await playBuiltin(target);
    expect(surface()).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(surface()).toBe(true);
  });

  it('counts a file that is playing as showing', () => {
    expect(videoShowing({ loaded: false, rendered: true, time: 5 })).toBe(false);
    expect(videoShowing({ loaded: true, rendered: false, time: 0 })).toBe(false);
    expect(videoShowing({ loaded: true, rendered: true, time: 0 })).toBe(true);
    expect(videoShowing({ loaded: true, time: 3 })).toBe(true);
  });
});

describe('controls while going full screen', () => {
  function fakeClock() {
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let id = 0;
    return {
      clock: {
        now: () => now,
        set: (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id),
        clear: (t: unknown) => void timers.delete(t as number),
      },
      advance(ms: number) {
        now += ms;
        for (const [k, t] of [...timers]) if (t.at <= now) (timers.delete(k), t.fn());
      },
    };
  }

  it('hides them from the request until the window has stopped resizing', () => {
    const { clock, advance } = fakeClock();
    const settle = createResizeSettle(clock);
    const seen: boolean[] = [];
    settle.subscribe(() => seen.push(settle.settling()));
    settle.begin();
    expect(settle.settling()).toBe(true);
    // Windows: the title bar goes, then the window grows to the screen.
    advance(80);
    settle.resized();
    advance(40);
    settle.resized();
    advance(SETTLE_QUIET_MS - 1);
    expect(settle.settling()).toBe(true);
    advance(1);
    expect(settle.settling()).toBe(false);
    // Shown once, at the final size: no flicker in between.
    expect(seen).toEqual([true, false]);
  });

  it('shows them again if the window never resizes, and never hides them for long', () => {
    const { clock, advance } = fakeClock();
    const settle = createResizeSettle(clock);
    settle.begin();
    advance(SETTLE_FIRST_RESIZE_MS);
    expect(settle.settling()).toBe(false);

    settle.begin();
    for (let t = 0; t < SETTLE_MAX_MS; t += 100) {
      settle.resized();
      advance(100);
    }
    expect(settle.settling()).toBe(false);
  });

  it('hides them for a resize the OS started too (leaving full screen from the title bar)', () => {
    const { clock, advance } = fakeClock();
    const settle = createResizeSettle(clock);
    settle.resized();
    expect(settle.settling()).toBe(true);
    advance(SETTLE_QUIET_MS);
    expect(settle.settling()).toBe(false);
  });

  it('hides them before the window is asked to go full screen', async () => {
    fullscreenCalls.length = 0;
    let settlingWhenAsked: boolean | null = null;
    const unsubscribe = resizeSettle.subscribe(() => {
      if (fullscreenCalls.length === 0 && settlingWhenAsked === null) settlingWhenAsked = resizeSettle.settling();
    });
    await toggleFullscreen();
    unsubscribe();
    expect(settlingWhenAsked).toBe(true);
    expect(fullscreenCalls).toEqual([true]);
    resizeSettle.end();
    await flush();
  });
});
