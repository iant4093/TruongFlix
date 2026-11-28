import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async () => {} }) }));

import MiniPlayer from '../src/components/player/MiniPlayer';
import { enterMini, exitMini, miniRect } from '../src/services/player';
import {
  clampToViewport,
  cornerPosition,
  DRAG_THRESHOLD,
  isDrag,
  MINI,
  MINI_CORNER_KEY,
  miniVideoSize,
  nearestCorner,
  readCorner,
  useMiniLayout,
} from '../src/services/miniLayout';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { PlayerSession } from '../src/types/media';

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

const big = { width: 1440, height: 900 };

describe('snapping to corners', () => {
  // 1440 wide: a 400×225 video plus its 64px bar.
  const frame = { w: 400, h: 225 + MINI.bar };

  it('rests each corner inside the window, clear of the nav bar at the top', () => {
    expect(cornerPosition('top-left', big)).toEqual({ x: MINI.margin, y: MINI.top });
    expect(cornerPosition('top-right', big)).toEqual({ x: big.width - MINI.margin - frame.w, y: MINI.top });
    expect(cornerPosition('bottom-left', big)).toEqual({ x: MINI.margin, y: big.height - MINI.margin - frame.h });
    expect(cornerPosition('bottom-right', big)).toEqual({ x: big.width - MINI.margin - frame.w, y: big.height - MINI.margin - frame.h });
    expect(MINI.top).toBeGreaterThanOrEqual(68);
  });

  it('picks the nearest corner from where it was dropped, even part of the way there', () => {
    // Resting spots: x 24 or 1016, y 84 or 587. Dropped well short of any of them:
    expect(nearestCorner({ x: 450, y: 300 }, big)).toBe('top-left');
    expect(nearestCorner({ x: 600, y: 300 }, big)).toBe('top-right');
    expect(nearestCorner({ x: 450, y: 400 }, big)).toBe('bottom-left');
    expect(nearestCorner({ x: 900, y: 500 }, big)).toBe('bottom-right');
    // Right on a corner, and dragged past the window's edge.
    expect(nearestCorner(cornerPosition('top-right', big), big)).toBe('top-right');
    expect(nearestCorner({ x: -300, y: 2000 }, big)).toBe('bottom-left');
  });

  it('measures against the window it is in', () => {
    const drop = { x: 500, y: 300 };
    expect(nearestCorner(drop, big)).toBe('top-left');
    // The same spot is in the right half of a narrow window.
    expect(nearestCorner(drop, { width: 960, height: 900 })).toBe('top-right');
    // And low in a short one.
    expect(nearestCorner({ x: 100, y: 300 }, { width: 1440, height: 640 })).toBe('bottom-left');
  });

  it('keeps the frame inside the window as it shrinks', () => {
    const small = { width: 960, height: 600 };
    const { w, h } = miniVideoSize(small.width);
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const at = cornerPosition(corner, small);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.x + w).toBeLessThanOrEqual(small.width);
      expect(at.y + h + MINI.bar).toBeLessThanOrEqual(small.height);
    }
    expect(clampToViewport({ x: 5000, y: -40 }, small)).toEqual({ x: small.width - w, y: 0 });
  });

  it('remembers only real corners', () => {
    expect(readCorner('top-left')).toBe('top-left');
    expect(readCorner(null)).toBe('bottom-right');
    expect(readCorner('middle')).toBe('bottom-right');
  });
});

describe('telling a drag from a click', () => {
  it('needs the pointer to move past the threshold', () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(DRAG_THRESHOLD - 1, 0)).toBe(false);
    expect(isDrag(4, 4)).toBe(false); // ~5.7px diagonally
    expect(isDrag(0, -DRAG_THRESHOLD)).toBe(true);
    expect(isDrag(5, 5)).toBe(true);
  });
});

describe('the mini player', () => {
  const view = { width: 1024, height: 768 };
  const original = window.matchMedia;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    localStorage.removeItem(MINI_CORNER_KEY);
    useLibraryStore.setState(useLibraryStore.getInitialState(), true);
    useLibraryStore.setState({ playerSession: session, playerMini: true });
    useMiniLayout.setState({ corner: 'bottom-right', free: null, viewport: view });
  });
  afterEach(() => {
    cleanup();
    window.matchMedia = original;
    vi.unstubAllGlobals();
  });

  const reduceMotion = () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query })) as unknown as typeof window.matchMedia;
  };
  const frame = () => document.querySelector('[data-mini-player]') as HTMLElement;
  const press = (el: Element, x: number, y: number) => fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x, clientY: y });
  const move = (x: number, y: number) => fireEvent.pointerMove(frame(), { pointerId: 1, clientX: x, clientY: y });
  const release = (el: Element, x: number, y: number) => fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y });

  it('still expands on a click that wobbles less than the threshold', async () => {
    render(<MiniPlayer />);
    const video = screen.getByLabelText('Expand player');
    press(video, 700, 500);
    move(703, 502);
    release(video, 703, 502);
    await act(async () => fireEvent.click(video));
    expect(useLibraryStore.getState().playerMini).toBe(false);
    expect(invoke).toHaveBeenCalledWith('player_layout', { rect: null });
    expect(useMiniLayout.getState().corner).toBe('bottom-right');
  });

  it('lets the controls work under a short press', async () => {
    render(<MiniPlayer />);
    const pause = screen.getByLabelText('Pause');
    press(pause, 650, 700);
    release(pause, 651, 700);
    await act(async () => fireEvent.click(pause));
    expect(invoke).toHaveBeenCalledWith('player_command', expect.objectContaining({ args: ['cycle', 'pause'] }));
  });

  it('snaps a drag to the nearest corner, remembers it and moves the video there', async () => {
    reduceMotion();
    render(<MiniPlayer />);
    const video = screen.getByLabelText('Expand player');
    expect(frame().style.left).toBe(`${cornerPosition('bottom-right', view).x}px`);
    press(video, 700, 500);
    // Part of the way toward the top-left.
    move(500, 400);
    move(300, 250);
    expect(useMiniLayout.getState().free).toEqual({ x: 231, y: 222 });
    // The native video follows (newest spot once the call before it is done).
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('player_layout', { rect: expect.objectContaining({ x: 231, y: 222 }) });
    release(video, 300, 250);
    // The click the browser sends after a drag doesn't expand the player.
    await act(async () => fireEvent.click(video));
    expect(useLibraryStore.getState().playerMini).toBe(true);

    const home = cornerPosition('top-left', view);
    expect(useMiniLayout.getState()).toMatchObject({ corner: 'top-left', free: null });
    expect(localStorage.getItem(MINI_CORNER_KEY)).toBe('top-left');
    expect(frame().style.left).toBe(`${home.x}px`);
    expect(frame().style.top).toBe(`${home.y}px`);
    await act(async () => {});
    expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(['player_layout', { rect: expect.objectContaining({ x: home.x, y: home.y }) }]);
  });

  it('glides into the corner when motion is allowed', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    render(<MiniPlayer />);
    const video = screen.getByLabelText('Expand player');
    press(video, 700, 500);
    move(300, 250);
    release(video, 300, 250);
    const run = (at: number) => act(() => {
      now.mockReturnValue(at);
      frames.splice(0).forEach((cb) => cb(at));
    });
    run(1100);
    const mid = useMiniLayout.getState().free!;
    expect(mid.x).toBeLessThan(231);
    expect(mid.x).toBeGreaterThan(cornerPosition('top-left', view).x);
    run(1400);
    expect(useMiniLayout.getState().free).toBeNull();
    expect(frames).toHaveLength(0);
    now.mockRestore();
  });

  it('never moves the video back into a corner after expanding mid-glide', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(<MiniPlayer />);
    const video = screen.getByLabelText('Expand player');
    press(video, 700, 500);
    move(300, 250);
    release(video, 300, 250);
    await act(async () => {});
    let finishFull = () => {};
    vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
      if ((args as { rect?: unknown } | undefined)?.rect === null) await new Promise<void>((r) => (finishFull = r));
    });
    const expanding = exitMini();
    await act(async () => {});
    // The glide keeps ticking while the video is going back to full-window.
    act(() => frames.splice(0).forEach((cb) => cb(performance.now() + 50)));
    await act(async () => {});
    finishFull();
    await act(async () => expanding);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'player_layout').at(-1)).toEqual(['player_layout', { rect: null }]);
    expect(useLibraryStore.getState().playerMini).toBe(false);
  });

  it('follows the window as it resizes', () => {
    render(<MiniPlayer />);
    act(() => useMiniLayout.setState({ viewport: { width: 1600, height: 1000 } }));
    const at = cornerPosition('bottom-right', { width: 1600, height: 1000 });
    expect(frame().style.left).toBe(`${at.x}px`);
    expect(frame().style.top).toBe(`${at.y}px`);
  });
});

describe('switching to and from the mini player', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useLibraryStore.setState(useLibraryStore.getInitialState(), true);
    useLibraryStore.setState({ playerSession: session, playerMini: false });
    useMiniLayout.setState({ corner: 'top-right', free: null, viewport: { width: 1024, height: 768 } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('moves the video into the corner only after the opaque page has painted', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const entering = enterMini();
    await act(async () => {});
    expect(useLibraryStore.getState().playerMini).toBe(true);
    // The page has switched, but the video is still full-size behind it.
    expect(invoke).not.toHaveBeenCalledWith('player_layout', expect.anything());
    for (let i = 0; i < 3; i++) frames.splice(0).forEach((cb) => cb(0));
    await entering;
    expect(invoke).toHaveBeenCalledWith('player_layout', { rect: miniRect() });
    expect(miniRect()).toMatchObject(cornerPosition('top-right', { width: 1024, height: 768 }));
  });

  it('puts the video back full-size before the page turns see-through', async () => {
    useLibraryStore.setState({ playerMini: true });
    const miniWhenCalled: boolean[] = [];
    vi.mocked(invoke).mockImplementation(async () => void miniWhenCalled.push(useLibraryStore.getState().playerMini));
    await exitMini();
    expect(invoke).toHaveBeenCalledWith('player_layout', { rect: null });
    expect(miniWhenCalled).toEqual([true]);
    expect(useLibraryStore.getState().playerMini).toBe(false);
  });
});
