import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2, Pause, Play, RotateCcw, X } from 'lucide-react';
import type { PlayerSession } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { closeBuiltin, dismissPrompt, exitMini, MINI, miniRect, noteUserActivity, playerCommand } from '../../services/player';

/**
 * Mini-player: the native video floats in the bottom-right corner (above the page, click-through),
 * and this draws the frame behind it plus a control bar underneath. Clicking the video expands it.
 */
export default function MiniPlayer() {
  const session = useLibraryStore((s) => s.playerSession);
  const mini = useLibraryStore((s) => s.playerMini);
  // The session is passed as a snapshot so the exit animation still renders after playback ends.
  return <AnimatePresence>{session && mini && <Mini key="mini" session={session} />}</AnimatePresence>;
}

function Mini({ session }: { session: PlayerSession }) {
  const state = useLibraryStore((s) => s.playerState);
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const [rect, setRect] = useState(miniRect);

  useEffect(() => {
    const onResize = () => setRect(miniRect());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const progress = state?.duration ? state.time / state.duration : 0;
  const btn = 'flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.2 }}
      className="fixed z-[120] overflow-hidden rounded-md bg-black shadow-[0_12px_40px_rgba(0,0,0,0.8)] ring-1 ring-white/15"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h + MINI.bar }}
    >
      {/* The native video covers this area; clicks fall through to it. */}
      <button
        type="button"
        aria-label="Expand player"
        title="Expand"
        onClick={() => void exitMini()}
        className="block w-full bg-black"
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
          <button type="button" className={btn} title="Stop" onClick={() => void closeBuiltin()}>
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 px-2" style={{ height: MINI.bar - 3 }} onClickCapture={noteUserActivity}>
          <button type="button" className={btn} title={state?.paused ? 'Play' : 'Pause'} onClick={() => void playerCommand('cycle', 'pause')}>
            {state?.paused ? <Play className="h-5 w-5 fill-white" strokeWidth={0} /> : <Pause className="h-5 w-5 fill-white" strokeWidth={0} />}
          </button>
          <button type="button" className={btn} title="Back 10 seconds" onClick={() => void playerCommand('seek', -10, 'relative')}>
            <RotateCcw className="h-[18px] w-[18px]" />
          </button>
          <div className="min-w-0 flex-1 px-2 leading-tight">
            <div className="truncate text-sm font-semibold">{session.title}</div>
            {session.subtitle && <div className="truncate text-xs text-nf-muted">{session.subtitle}</div>}
          </div>
          <button type="button" className={btn} title="Expand" onClick={() => void exitMini()}>
            <Maximize2 className="h-[18px] w-[18px]" />
          </button>
          <button type="button" className={btn} title="Stop" onClick={() => void closeBuiltin()}>
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </motion.div>
  );
}
