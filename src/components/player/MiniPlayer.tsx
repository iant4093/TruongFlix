import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2, Pause, Play, RotateCcw, X } from 'lucide-react';
import type { PlaybackSession } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { closeBuiltin, dismissPrompt, exitMini, goLive, noteUserActivity, placeMini, playerCommand } from '../../services/player';
import { cornerPosition, isDrag, MINI, miniFramePosition, nearestCorner, setMiniCorner, useMiniLayout, useMiniVideoRect, type Point } from '../../services/miniLayout';
import { useLiveStore } from '../../services/live';

/** How long the mini player glides into its corner after a drag. */
const SNAP_MS = 280;

function reducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

/**
 * Mini-player: the native video floats in a corner of the window (above the page, click-through),
 * and this draws the frame behind it plus a control bar underneath. Clicking the video expands it;
 * dragging the frame moves it, and on release it snaps to the nearest corner (remembered).
 */
export default function MiniPlayer() {
  const session = useLibraryStore((s) => s.playerSession);
  const mini = useLibraryStore((s) => s.playerMini);
  // The session is passed as a snapshot so the exit animation still renders after playback ends.
  // Expanding back to the full player (session still there) removes the frame at once: fading it
  // out would draw a black box over the corner of the full-window video.
  return (
    <AnimatePresence custom={!!session}>
      {session && mini && <Mini key="mini" session={session} />}
    </AnimatePresence>
  );
}

const frameMotion = {
  shown: { opacity: 1, y: 0, transition: { duration: 0.2 } },
  hidden: (top: boolean) => ({ opacity: 0, y: top ? -12 : 12 }),
  gone: (expanding: boolean) =>
    expanding ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 12, transition: { duration: 0.2 } },
};

type Press = { id: number; start: Point; origin: Point; dragging: boolean };

function Mini({ session }: { session: PlaybackSession }) {
  const state = useLibraryStore((s) => s.playerState);
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const webPaused = useLiveStore((s) => s.webPaused);
  const top = useMiniLayout((s) => s.corner.startsWith('top'));
  const rect = useMiniVideoRect();
  const [dragging, setDragging] = useState(false);
  const press = useRef<Press | null>(null);
  const swallowClick = useRef(false);
  const stopGlide = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      stopGlide.current?.();
      useMiniLayout.setState({ free: null });
    },
    [],
  );

  /** Glides from where it was dropped into its corner (or jumps there for reduced motion). */
  const glideHome = (from: Point) => {
    stopGlide.current?.();
    const { corner, viewport } = useMiniLayout.getState();
    const to = cornerPosition(corner, viewport);
    if (reducedMotion() || (from.x === to.x && from.y === to.y)) return placeMini(null);
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, Math.max(0, now - started) / SNAP_MS);
      if (t >= 1) {
        stopGlide.current = null;
        return placeMini(null);
      }
      const eased = 1 - (1 - t) ** 3;
      placeMini({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased });
      frame = requestAnimationFrame(step);
    });
    stopGlide.current = () => {
      cancelAnimationFrame(frame);
      stopGlide.current = null;
    };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || press.current) return;
    // Caught mid-glide: carry on from where it is now.
    const origin = miniFramePosition();
    stopGlide.current?.();
    press.current = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, origin, dragging: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.start.x;
    const dy = e.clientY - p.start.y;
    if (!p.dragging) {
      // Under the threshold it's still a click on whatever was pressed.
      if (!isDrag(dx, dy)) return;
      p.dragging = true;
      setDragging(true);
      // Captured only once it's a drag: capturing on press would send the click to the frame
      // instead of the control that was pressed.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    placeMini({ x: p.origin.x + dx, y: p.origin.y + dy });
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (!p.dragging) {
      // Pressed mid-glide and let go without dragging: finish the trip.
      if (useMiniLayout.getState().free) glideHome(miniFramePosition());
      return;
    }
    setDragging(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    // The click that follows a drag isn't a click on a control.
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 0);
    const from = miniFramePosition();
    setMiniCorner(nearestCorner(from, useMiniLayout.getState().viewport));
    glideHome(from);
  };

  const live = session.target.type === 'live';
  // Web channels draw their own frame over the video area and can only be stopped and restarted.
  const web = live && 'web' in session && !!session.web;
  const paused = web ? webPaused : state?.paused;
  const togglePause = () => (web ? useLiveStore.setState({ webPaused: !webPaused }) : void playerCommand('cycle', 'pause'));
  const progress = !live && state?.duration ? state.time / state.duration : 0;
  const btn = 'flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white';

  return (
    <motion.div
      data-mini-player=""
      custom={top}
      variants={frameMotion}
      initial="hidden"
      animate="shown"
      exit="gone"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      className={`fixed z-[120] touch-none select-none overflow-hidden rounded-md bg-black shadow-[0_12px_40px_rgba(0,0,0,0.8)] ring-1 ring-white/15 ${dragging ? 'cursor-grabbing' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h + MINI.bar }}
    >
      {/* The native video covers this area; clicks fall through to it. */}
      <button
        type="button"
        aria-label="Expand player"
        title="Expand · drag to move"
        onClick={() => void exitMini()}
        className={`block w-full bg-black ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ height: rect.h }}
      />
      <div className="relative h-[3px] w-full bg-white/20">
        <div className="absolute inset-y-0 left-0 bg-nf-red" style={{ width: `${progress * 100}%` }} />
      </div>
      {prompt ? (
        <div className="flex items-center gap-2 px-3" style={{ height: MINI.bar - 3 }}>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {prompt === 'still-watching' ? 'Still watching?' : prompt === 'limit' ? 'That’s all for today!' : prompt === 'bedtime' ? 'It’s bedtime' : 'Sleep timer ended'}
          </span>
          {prompt !== 'limit' && prompt !== 'bedtime' && (
            <button type="button" onClick={dismissPrompt} className="rounded bg-white px-3 py-1.5 text-xs font-bold text-black hover:bg-white/80">
              {prompt === 'still-watching' ? 'Continue' : 'Resume'}
            </button>
          )}
          <button type="button" className={btn} aria-label="Stop" title="Stop" onClick={() => void closeBuiltin()}>
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 px-2" style={{ height: MINI.bar - 3 }} onClickCapture={noteUserActivity}>
          <button type="button" className={btn} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play' : 'Pause'} onClick={togglePause}>
            {paused ? <Play className="h-5 w-5 fill-white" strokeWidth={0} /> : <Pause className="h-5 w-5 fill-white" strokeWidth={0} />}
          </button>
          {!web && <button type="button" className={btn} aria-label={live ? 'Go live' : 'Back 10 seconds'} title={live ? 'Go live' : 'Back 10 seconds'} onClick={() => void (live ? goLive() : playerCommand('seek', -10, 'relative'))}>
            <RotateCcw className="h-[18px] w-[18px]" />
          </button>}
          <div className="min-w-0 flex-1 px-2 leading-tight">
            <div className="truncate text-sm font-semibold">{live && <span className="mr-2 text-[10px] text-red-400">LIVE</span>}{session.title}</div>
            {session.subtitle && <div className="truncate text-xs text-nf-muted">{session.subtitle}</div>}
          </div>
          <button type="button" className={btn} aria-label="Expand" title="Expand" onClick={() => void exitMini()}>
            <Maximize2 className="h-[18px] w-[18px]" />
          </button>
          <button type="button" className={btn} aria-label="Stop" title="Stop" onClick={() => void closeBuiltin()}>
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </motion.div>
  );
}
