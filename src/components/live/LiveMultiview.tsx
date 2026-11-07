import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeft, Loader2, Maximize, Pause, Play, RefreshCw, SquarePlay, Volume2, VolumeX } from 'lucide-react';
import type { LivePlayerSession } from '../../types/live';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useLiveStore } from '../../services/live';
import {
  closeBuiltin,
  dismissPrompt,
  openLiveMultiviewPane,
  playerSet,
  retryLiveMultiview,
  toggleFullscreen,
  watchLivePane,
  type MultiviewLayout,
} from '../../services/player';
import { button } from './ui';
import { isPlayerShortcut } from '../player/shortcuts';

function box(node: HTMLDivElement) {
  const rect = node.getBoundingClientRect();
  return {
    x: rect.left, y: rect.top, w: rect.width, h: rect.height,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  };
}

export default function LiveMultiview({ session }: { session: LivePlayerSession & { multiview: NonNullable<LivePlayerSession['multiview']> } }) {
  const primary = useLibraryStore((s) => s.playerState);
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const toast = useLibraryStore((s) => s.toast);
  const primaryError = useLiveStore((s) => s.playbackError);
  const secondary = useLiveStore((s) => s.multiviewState);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [paneId, setPaneId] = useState(() => crypto.randomUUID());
  const [opening, setOpening] = useState(true);
  const [secondError, setSecondError] = useState('');
  const [firstTimedOut, setFirstTimedOut] = useState(false);
  const [secondTimedOut, setSecondTimedOut] = useState(false);
  const [audio, setAudio] = useState<'left' | 'right'>('left');
  const [changingAudio, setChangingAudio] = useState(false);
  const [switching, setSwitching] = useState(false);
  const activeSecondary = secondary?.loadId === session.loadId && secondary?.paneId === paneId ? secondary : null;
  const readLayout = (): MultiviewLayout | undefined => {
    if (!left.current || !right.current) return;
    const layout = { left: box(left.current), right: box(right.current) };
    if (layout.left.w > 0 && layout.left.h > 0 && layout.right.w > 0 && layout.right.h > 0) return layout;
  };

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    const applyLayout = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const layout = readLayout();
        if (layout) void invoke('player_multiview_layout', { loadId: session.loadId, ...layout }).catch(() => {});
      });
    };
    setOpening(true);
    setSecondError('');
    setSecondTimedOut(false);
    setAudio('left');

    // Read the layout after React commits both panes. The playback service waits for the primary
    // player, so both native views belong to this session even when Back is clicked during startup.
    const start = window.requestAnimationFrame(async () => {
      const layout = readLayout();
      if (!layout) {
        setSecondError('Could not size the second video pane.');
        setOpening(false);
        return;
      }
      try {
        await openLiveMultiviewPane(session, paneId, layout);
      } catch (error) {
        if (!disposed) setSecondError(typeof error === 'string' ? error : 'The second channel could not start.');
      } finally {
        if (!disposed) {
          setOpening(false);
          applyLayout();
        }
      }
    });

    const observer = new ResizeObserver(applyLayout);
    if (left.current) observer.observe(left.current);
    if (right.current) observer.observe(right.current);
    window.addEventListener('resize', applyLayout);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', applyLayout);
      window.cancelAnimationFrame(start);
      window.cancelAnimationFrame(frame);
    };
  }, [session.loadId, paneId]);

  useEffect(() => {
    setFirstTimedOut(false);
    if (primary?.loaded && !primary.buffering || prompt) return;
    const timer = window.setTimeout(() => setFirstTimedOut(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [session.loadId, primary?.loaded, primary?.buffering, prompt]);

  useEffect(() => {
    setSecondTimedOut(false);
    if (activeSecondary?.loaded && !activeSecondary.buffering || prompt) return;
    const timer = window.setTimeout(() => setSecondTimedOut(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [paneId, activeSecondary?.loaded, activeSecondary?.buffering, prompt]);

  const back = async () => {
    const fullscreen = await getCurrentWindow().isFullscreen().catch(() => false);
    if (fullscreen) await toggleFullscreen();
    else await closeBuiltin();
  };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!isPlayerShortcut(event)) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void back();
        return;
      }
      if (prompt) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void playerSet('pause', primary?.paused ? 'no' : 'yes');
      }
      if (event.code === 'KeyF') void toggleFullscreen();
      if (event.code === 'KeyM') void playerSet('mute', primary?.muted ? 'no' : 'yes');
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [primary?.paused, primary?.muted, prompt]);

  const chooseAudio = async (target: 'left' | 'right') => {
    if (changingAudio || target === audio) return;
    setChangingAudio(true);
    try {
      await invoke('player_multiview_audio', { loadId: session.loadId, secondary: target === 'right' });
      setAudio(target);
    } catch {
      toast('Could not switch audio.', 'error');
    } finally {
      setChangingAudio(false);
    }
  };

  const switchPlayer = async (action: () => void | Promise<void>) => {
    setSwitching(true);
    try { await action(); }
    finally { setSwitching(false); }
  };
  const firstFailure = primaryError || (primary?.eof ? 'This stream ended.' : firstTimedOut ? 'This channel did not start in time.' : '');
  const secondFailure = secondError || (activeSecondary?.failed ? 'This stream could not be played.' : secondTimedOut ? 'This channel did not start in time.' : '');

  return (
    <section className="fixed inset-0 z-[110] flex min-h-0 flex-col text-white" aria-label="Live TV multiview">
      <header className="flex items-center gap-4 border-b border-white/10 bg-[#141414] px-[4%] py-4">
        <button className={button} disabled={!!prompt} onClick={() => void closeBuiltin()} aria-label="Back to Live TV"><ArrowLeft className="h-5 w-5" /></button>
        <h1 className="flex-1 text-xl font-bold">Live TV multiview</h1>
        <button className={button} disabled={!!prompt} onClick={() => void toggleFullscreen()} aria-label="Toggle fullscreen" title="Toggle fullscreen (F)"><Maximize className="h-5 w-5" /></button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-2">
        {[
          { key: 'left' as const, name: session.title, subtitle: session.subtitle, ref: left, error: firstFailure, buffering: !primary?.loaded || primary.buffering },
          { key: 'right' as const, name: session.multiview.title, subtitle: session.multiview.subtitle, ref: right, error: secondFailure, buffering: !activeSecondary?.loaded || activeSecondary.buffering },
        ].map((pane) => {
          const isRight = pane.key === 'right';
          return (
            <div key={pane.key} className="flex min-h-0 min-w-0 flex-col border-r border-white/10 last:border-r-0">
              <div className={`flex items-center justify-between gap-3 border-b bg-[#181818] px-4 py-3 ${audio === pane.key ? 'border-sky-400' : 'border-white/10'}`}>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-bold" title={pane.name}>{pane.name}</h2>
                  {pane.subtitle && <p className="truncate text-xs text-nf-secondary" title={pane.subtitle}>{pane.subtitle}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className={button}
                    onClick={() => void chooseAudio(pane.key)}
                    disabled={opening || changingAudio || pane.buffering || !!pane.error || !!prompt}
                    aria-pressed={audio === pane.key}
                    aria-label={`Listen to ${pane.name}`}
                    title={audio === pane.key ? 'Audio selected' : 'Listen to this channel'}
                  >
                    {audio === pane.key ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                  </button>
                  <button
                    className={button}
                    aria-label={`Watch ${pane.name} alone`}
                    title="Watch this channel alone"
                    disabled={switching || !!prompt}
                    onClick={() => void switchPlayer(() => watchLivePane(session, isRight))}
                  >
                    <SquarePlay className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div ref={pane.ref} className="relative min-h-0 flex-1">
                {pane.error ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 p-4 text-center">
                    <p className="text-sm" role="status">{pane.error}</p>
                    <button
                      className={button}
                      disabled={opening || switching || !!prompt}
                      onClick={() => isRight
                        ? setPaneId(crypto.randomUUID())
                        : void switchPlayer(() => retryLiveMultiview(session))}
                    >
                      <RefreshCw className="h-4 w-4" /> {isRight ? 'Retry channel' : 'Retry multiview'}
                    </button>
                  </div>
                ) : pane.buffering && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/80" role="status" aria-label={`Buffering ${pane.name}`}>
                    <Loader2 className="h-8 w-8 animate-spin text-nf-red" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="flex items-center gap-3 border-t border-white/10 bg-[#141414] px-[4%] py-3">
        <button
          className={button}
          disabled={!!prompt}
          title={primary?.paused ? 'Resume both (Space)' : 'Pause both (Space)'}
          onClick={() => void playerSet('pause', primary?.paused ? 'no' : 'yes')}
        >
          {primary?.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {primary?.paused ? 'Resume both' : 'Pause both'}
        </button>
        <button
          className={button}
          disabled={!!prompt}
          aria-label={primary?.muted ? 'Unmute multiview' : 'Mute multiview'}
          title={primary?.muted ? 'Unmute (M)' : 'Mute (M)'}
          onClick={() => void playerSet('mute', primary?.muted ? 'no' : 'yes')}
        >
          {primary?.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <input
          type="range"
          aria-label="Multiview volume"
          min={0}
          max={100}
          value={primary?.volume ?? 100}
          disabled={!!prompt}
          onChange={(event) => void playerSet('volume', event.target.value)}
          className="w-20 accent-white"
        />
        <span className="min-w-0 truncate text-xs text-nf-secondary">Audio: {audio === 'left' ? session.title : session.multiview.title}</span>
      </footer>
      {prompt && (
        <div key={prompt} role="dialog" aria-modal="true" aria-label="Playback paused" className="absolute inset-0 z-20 flex items-center justify-center bg-black/75">
          <div className="rounded-lg bg-[#181818] p-8 text-center">
            <h2 className="mb-5 text-xl font-bold">
              {prompt === 'limit' ? 'That’s all for today!' : prompt === 'bedtime' ? 'It’s bedtime' : 'Playback paused'}
            </h2>
            <div className="flex justify-center gap-3">
              {prompt !== 'limit' && prompt !== 'bedtime' && <button className="nf-btn-red" autoFocus onClick={dismissPrompt}>Resume</button>}
              <button className={button} autoFocus={prompt === 'limit' || prompt === 'bedtime'} onClick={() => void closeBuiltin()}>Back to Live TV</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
