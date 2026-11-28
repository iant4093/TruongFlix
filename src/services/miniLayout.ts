import { useMemo } from 'react';
import { create } from 'zustand';

/**
 * Where the mini player sits: one of the window's four corners, which the user picks by dragging
 * it there (it snaps to the nearest corner on release). Pure geometry plus a tiny store, so the
 * frame, the web channel frame, the native video surface and the toasts all agree on one spot.
 */

export type MiniCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export const MINI_CORNERS: readonly MiniCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export const MINI = {
  /** Widest the video gets (CSS px); narrower windows get 36% of their width. */
  width: 400,
  /** Gap to the window's sides and bottom. */
  margin: 24,
  /** The control bar under the video. */
  bar: 64,
  /** Gap from the top of the window: the nav bar (68px, with the downloads indicator) plus room. */
  top: 68 + 16,
};

/** How far (CSS px) the pointer must move before a press on the mini player becomes a drag. */
export const DRAG_THRESHOLD = 6;

export type Viewport = { width: number; height: number };
export type Point = { x: number; y: number };

/** A press that moved at least `DRAG_THRESHOLD` px is a drag; anything less is a click. */
export function isDrag(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

/** The video's size (CSS px) in a window this wide: 16:9. */
export function miniVideoSize(viewportWidth: number) {
  const w = Math.max(1, Math.min(MINI.width, Math.round(viewportWidth * 0.36)));
  return { w, h: Math.round((w * 9) / 16) };
}

/** The whole frame (video plus its control bar). */
function frameSize(view: Viewport) {
  const { w, h } = miniVideoSize(view.width);
  return { w, h: h + MINI.bar };
}

/** Keeps the frame's top-left inside the window (as far as it fits). */
export function clampToViewport(at: Point, view: Viewport): Point {
  const { w, h } = frameSize(view);
  return {
    x: Math.round(Math.min(Math.max(0, at.x), Math.max(0, view.width - w))),
    y: Math.round(Math.min(Math.max(0, at.y), Math.max(0, view.height - h))),
  };
}

/** The frame's top-left when it rests in `corner`. */
export function cornerPosition(corner: MiniCorner, view: Viewport): Point {
  const { w, h } = frameSize(view);
  const left = corner.endsWith('left');
  const top = corner.startsWith('top');
  return clampToViewport(
    {
      x: left ? MINI.margin : view.width - MINI.margin - w,
      // Small windows: never above the nav bar's gap at the top, never below the window at the bottom.
      y: top ? MINI.top : Math.max(MINI.top, view.height - MINI.margin - h),
    },
    view,
  );
}

/** The corner whose resting spot is closest to where the frame was dropped (its top-left). */
export function nearestCorner(drop: Point, view: Viewport): MiniCorner {
  let best: MiniCorner = 'bottom-right';
  let bestDistance = Infinity;
  for (const corner of MINI_CORNERS) {
    const at = cornerPosition(corner, view);
    const distance = Math.hypot(at.x - drop.x, at.y - drop.y);
    if (distance < bestDistance) {
      best = corner;
      bestDistance = distance;
    }
  }
  return best;
}

/** The video rectangle (CSS px) the native surface is placed at, for a frame at `at`. */
export function miniVideoRect(at: Point, view: Viewport) {
  const { w, h } = miniVideoSize(view.width);
  return { x: at.x, y: at.y, w, h, viewportWidth: view.width, viewportHeight: view.height };
}
export type MiniVideoRect = ReturnType<typeof miniVideoRect>;

// ---------------------------------------------------------------------------
// The remembered corner
// ---------------------------------------------------------------------------

export const MINI_CORNER_KEY = 'tf-mini-corner';

export function readCorner(raw: string | null): MiniCorner {
  return MINI_CORNERS.includes(raw as MiniCorner) ? (raw as MiniCorner) : 'bottom-right';
}

function storedCorner(): MiniCorner {
  try {
    return readCorner(localStorage.getItem(MINI_CORNER_KEY));
  } catch {
    return 'bottom-right';
  }
}

type MiniLayoutState = {
  corner: MiniCorner;
  /** The frame's top-left while it's dragged or gliding into its corner; null when it rests. */
  free: Point | null;
  /** The window's size, kept current so the frame follows resizes. */
  viewport: Viewport;
};

function currentViewport(): Viewport {
  return typeof window === 'undefined' ? { width: 1440, height: 900 } : { width: window.innerWidth, height: window.innerHeight };
}

export const useMiniLayout = create<MiniLayoutState>(() => ({
  corner: storedCorner(),
  free: null,
  viewport: currentViewport(),
}));

export function setMiniCorner(corner: MiniCorner) {
  useMiniLayout.setState({ corner });
  try {
    localStorage.setItem(MINI_CORNER_KEY, corner);
  } catch {
    /* private mode: just this session */
  }
}

/** Re-reads the window size (on resize, and before measuring). */
export function refreshMiniViewport() {
  const viewport = currentViewport();
  const old = useMiniLayout.getState().viewport;
  if (old.width !== viewport.width || old.height !== viewport.height) {
    const free = useMiniLayout.getState().free;
    useMiniLayout.setState({ viewport, free: free && clampToViewport(free, viewport) });
  }
  return viewport;
}

/** Where the frame's top-left is now. */
export function miniFramePosition(state: MiniLayoutState = useMiniLayout.getState()): Point {
  return state.free ?? cornerPosition(state.corner, state.viewport);
}

/** The mini video's rectangle, re-rendering as it's dragged, snaps or the window resizes. */
export function useMiniVideoRect(): MiniVideoRect {
  const corner = useMiniLayout((s) => s.corner);
  const free = useMiniLayout((s) => s.free);
  const viewport = useMiniLayout((s) => s.viewport);
  return useMemo(() => miniVideoRect(free ?? cornerPosition(corner, viewport), viewport), [corner, free, viewport]);
}
