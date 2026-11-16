import { useEffect, useState } from 'react';
import useIdle from '../../hooks/useIdle';
import { ArrowLeft, ChevronDown, ChevronUp, Globe, Maximize, PanelsTopLeft, PictureInPicture2, Play, RefreshCw } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { LivePlayerSession } from '../../types/live';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useLiveStore } from '../../services/live';
import { closeBuiltin, dismissPrompt, enterMini, miniRect, retuneLive, tickWebLive, toggleFullscreen } from '../../services/player';
import { isPlayerShortcut } from '../player/shortcuts';
import Spinner from '../common/Spinner';
import LiveWebFrame, { type WebFrameStatus } from './LiveWebFrame';
import MultiviewPicker from './LiveMultiviewPicker';

const control =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:bg-white/15 disabled:opacity-30';

/**
 * A channel from a web channel list. The list's own player draws the video and its playback
 * controls (restyled to TruongFlix's colors); TruongFlix keeps the title bar, channel switching,
 * fullscreen, the mini player, time limits and the sleep timer. The frame stays mounted when it
 * shrinks into the mini player, so the stream keeps playing.
 */
export default function LiveWebPlayer({ session }: { session: LivePlayerSession & { web: { url: string; source: string } } }) {
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const mini = useLibraryStore((s) => s.playerMini);
  const paused = useLiveStore((s) => s.webPaused);
  const [status, setStatus] = useState<WebFrameStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const [picking, setPicking] = useState(false);
  const [rect, setRect] = useState(miniRect);
  const { active: visible, wake: reveal } = useIdle();
  const blocked = !!prompt;
  const showFrame = !blocked && !paused;
  const failed = status === 'failed';
  const reload = () => setAttempt((n) => n + 1);
  useEffect(reveal, [session.loadId]);
  useEffect(() => {
    if (!mini) return;
    setRect(miniRect());
    const onResize = () => setRect(miniRect());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mini]);
  useEffect(() => {
    const clock = window.setInterval(() => tickWebLive(showFrame && status === 'ready'), 1000);
    return () => window.clearInterval(clock);
  }, [showFrame, status]);
  // Clicking the web player moves keyboard focus into its frame, where F, Esc and the channel keys
  // can't be heard; hand focus back to TruongFlix right after (the click itself still lands).
  useEffect(() => {
    if (mini) return;
    const reclaim = () =>
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement && !document.fullscreenElement) {
          active.blur();
          window.focus();
        }
      }, 0);
    window.addEventListener('blur', reclaim);
    return () => window.removeEventListener('blur', reclaim);
  }, [mini]);
  useEffect(() => {
    if (mini) return;
    const key = (event: KeyboardEvent) => {
      if (!isPlayerShortcut(event)) return;
      reveal();
      if (picking) {
        if (event.code === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          setPicking(false);
        }
        return;
      }
      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void getCurrentWindow()
          .isFullscreen()
          .then(async (fullscreen) => (fullscreen ? toggleFullscreen() : closeBuiltin()));
        return;
      }
      if (blocked) return;
      if (event.code === 'PageUp') {
        event.preventDefault();
        void retuneLive(-1);
      }
      if (event.code === 'PageDown') {
        event.preventDefault();
        void retuneLive(1);
      }
      if (event.code === 'KeyF') void toggleFullscreen();
      if (event.code === 'KeyI') void enterMini();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [blocked, mini, picking]);
  const show = visible || blocked || paused || picking || failed || status === 'loading';
  return (
    // In the mini player this layer sits above the mini player's frame (z-120) so the video shows.
    <div
      className={`fixed inset-0 text-white ${mini ? 'pointer-events-none z-[121]' : `z-[110] bg-black ${show ? '' : 'cursor-none'}`}`}
      onMouseMove={mini ? undefined : reveal}
    >
      {showFrame && (
        <LiveWebFrame
          key={session.loadId}
          url={session.web.url}
          title={`${session.title} live`}
          reload={attempt}
          onStatus={setStatus}
          // In the mini player the frame sits over the mini player's video area.
          className={mini ? 'pointer-events-auto fixed rounded-t-md' : 'absolute inset-0 h-full w-full'}
          style={mini ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
        />
      )}
      {!mini && (
        <>
          {showFrame && status === 'loading' && (
            <div role="status" aria-label="Loading channel" className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Spinner className="h-12 w-12" />
            </div>
          )}
          {/* Wakes the controls (and shows the cursor) on the first move over the web player. */}
          {!show && (
            <div
              className="absolute inset-0 z-[5] cursor-none"
              onMouseMove={reveal}
              onMouseDown={reveal}
              onDoubleClick={() => void toggleFullscreen()}
              aria-hidden
            />
          )}
          {/* The bar stays reachable: hovering its strip brings it back over the web player. */}
          <div
            hidden={blocked}
            onMouseEnter={reveal}
            onMouseMove={reveal}
            className={`absolute inset-x-0 top-0 z-10 items-center gap-5 bg-gradient-to-b from-black/85 to-transparent px-[4%] pb-10 pt-6 transition-opacity ${blocked ? 'hidden' : 'flex'} ${show ? 'opacity-100' : 'opacity-0 has-[:focus-visible]:opacity-100'}`}
          >
            <button className={control} aria-label="Back to Live TV" onClick={() => void closeBuiltin()}>
              <ArrowLeft />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <span className="rounded bg-nf-red px-2 py-0.5 text-[10px] font-bold tracking-widest">LIVE TV</span>
                <h1 className="truncate text-xl font-bold">{session.title}</h1>
              </div>
              <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-white/60">
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {session.event?.name ? `${session.event.name} · ` : ''}
                {session.web.source} · Web player
              </p>
            </div>
            <button className={control} aria-label="Previous channel" onClick={() => void retuneLive(-1)}>
              <ChevronUp />
            </button>
            <button className={control} aria-label="Next channel" onClick={() => void retuneLive(1)}>
              <ChevronDown />
            </button>
            <button className={control} aria-label="Reload channel" onClick={reload}>
              <RefreshCw />
            </button>
            <button className={control} aria-label="Start multiview" title="Multiview: add channels" onClick={() => setPicking(true)}>
              <PanelsTopLeft />
            </button>
            <button className={control} aria-label="Live mini-player" title="Mini player (I)" onClick={() => void enterMini()}>
              <PictureInPicture2 />
            </button>
            <button className={control} aria-label="Toggle live fullscreen" title="Toggle fullscreen (F)" onClick={() => void toggleFullscreen()}>
              <Maximize />
            </button>
          </div>
          {picking && !blocked && <MultiviewPicker session={session} onClose={() => setPicking(false)} />}
          {blocked ? (
            <div key={prompt} role="dialog" aria-modal="true" aria-label="Playback paused" className="absolute inset-0 z-20 flex items-center justify-center bg-black/70">
              <div className="rounded-lg bg-nf-surface p-8 text-center">
                <h2 className="mb-4 text-2xl font-bold">
                  {prompt === 'limit' ? 'That’s all for today!' : prompt === 'bedtime' ? 'It’s bedtime' : 'Sleep timer ended'}
                </h2>
                <div className="flex justify-center gap-3">
                  {prompt !== 'limit' && prompt !== 'bedtime' && (
                    <button className="nf-btn-red" autoFocus onClick={dismissPrompt}>
                      Resume
                    </button>
                  )}
                  <button className="nf-btn-ghost" autoFocus={prompt === 'limit' || prompt === 'bedtime'} onClick={() => void closeBuiltin()}>
                    Back to Live TV
                  </button>
                </div>
              </div>
            </div>
          ) : paused ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <button className="nf-btn-red" autoFocus onClick={() => useLiveStore.setState({ webPaused: false })}>
                <Play className="h-4 w-4 fill-current" /> Resume
              </button>
            </div>
          ) : (
            failed && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <div className="max-w-md rounded-lg bg-nf-surface/95 p-8 text-center">
                  <h2 className="text-xl font-bold">Channel didn’t load</h2>
                  <p className="mt-2 text-sm text-white/60">The web player didn’t answer. Try again or choose another channel.</p>
                  <div className="mt-6 flex justify-center gap-3">
                    <button className="nf-btn-red" onClick={reload}>
                      <RefreshCw className="h-4 w-4" /> Retry
                    </button>
                    <button className="nf-btn-ghost" onClick={() => void retuneLive(1)}>
                      Next channel
                    </button>
                  </div>
                </div>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
