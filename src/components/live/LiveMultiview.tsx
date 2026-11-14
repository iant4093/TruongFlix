import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeft, Globe, Maximize, Pause, Play, RefreshCw, SquarePlay, Volume2, VolumeX } from 'lucide-react';
import type { LivePlayerSession } from '../../types/live';
import { useLibraryStore } from '../../store/useLibraryStore';
import Spinner from '../common/Spinner';
import { useLiveStore } from '../../services/live';
import {
  closeBuiltin,
  dismissPrompt,
  openLiveMultiviewPane,
  playerSet,
  retryLiveMultiview,
  tickWebLive,
  toggleFullscreen,
  watchLivePane,
  type MultiviewLayout,
} from '../../services/player';
import { button } from './ui';
import { isPlayerShortcut } from '../player/shortcuts';
import LiveWebFrame, { type WebFrameStatus } from './LiveWebFrame';

type Side = 'left' | 'right';

function box(node: HTMLDivElement) {
  const rect = node.getBoundingClientRect();
  return {
    x: rect.left, y: rect.top, w: rect.width, h: rect.height,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  };
}

/**
 * Two channels side by side. Each pane is either native video (M3U channels) or a web player
 * (web channel lists). Two native channels share the native multiview; a single native channel
 * is the main player placed in its pane; web panes are frames.
 */
export default function LiveMultiview({ session }: { session: LivePlayerSession & { multiview: NonNullable<LivePlayerSession['multiview']> } }) {
  const primary = useLibraryStore((s) => s.playerState);
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const toast = useLibraryStore((s) => s.toast);
  const primaryError = useLiveStore((s) => s.playbackError);
  const secondary = useLiveStore((s) => s.multiviewState);
  const webPaused = useLiveStore((s) => s.webPaused);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const web = { left: session.web, right: session.multiview.web };
  const bothNative = !web.left && !web.right;
  // The pane the main native player shows, if any.
  const nativePane: Side | null = !web.left ? 'left' : !web.right ? 'right' : null;
  const [paneId, setPaneId] = useState(() => crypto.randomUUID());
  const [opening, setOpening] = useState(bothNative);
  const [secondError, setSecondError] = useState('');
  const [firstTimedOut, setFirstTimedOut] = useState(false);
  const [secondTimedOut, setSecondTimedOut] = useState(false);
  const [audio, setAudio] = useState<Side>('left');
  const [changingAudio, setChangingAudio] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [webStatus, setWebStatus] = useState<Record<Side, WebFrameStatus>>({ left: 'loading', right: 'loading' });
  const [webReload, setWebReload] = useState<Record<Side, number>>({ left: 0, right: 0 });
  const activeSecondary = secondary?.loadId === session.loadId && secondary?.paneId === paneId ? secondary : null;
  const readLayout = (): MultiviewLayout | undefined => {
    if (!left.current || !right.current) return;
    const layout = { left: box(left.current), right: box(right.current) };
    if (layout.left.w > 0 && layout.left.h > 0 && layout.right.w > 0 && layout.right.h > 0) return layout;
  };

  // Two native channels: open the second native view beside the main one.
  useEffect(() => {
    if (!bothNative) return;
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
  }, [session.loadId, paneId, bothNative]);

  // One native channel: place the main player in its pane once it is running.
  useEffect(() => {
    if (bothNative || !nativePane || !primary?.loaded) return;
    const pane = nativePane === 'left' ? left : right;
    let frame = 0;
    const applyLayout = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (pane.current) void invoke('player_layout', { rect: box(pane.current) }).catch(() => {});
      });
    };
    applyLayout();
    const observer = new ResizeObserver(applyLayout);
    if (pane.current) observer.observe(pane.current);
    window.addEventListener('resize', applyLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', applyLayout);
      window.cancelAnimationFrame(frame);
    };
  }, [session.loadId, bothNative, nativePane, primary?.loaded]);

  // Only one channel is heard. A web pane is reloaded muted or unmuted; a lone native pane is muted.
  useEffect(() => {
    if (!bothNative && nativePane && primary?.loaded) void playerSet('mute', audio === nativePane ? 'no' : 'yes');
  }, [audio, bothNative, nativePane, primary?.loaded, session.loadId]);

  // Watch time and limits when no native player is reporting.
  useEffect(() => {
    if (nativePane) return;
    const playing = !webPaused && !prompt && (webStatus.left === 'ready' || webStatus.right === 'ready');
    const clock = window.setInterval(() => tickWebLive(playing), 1000);
    return () => window.clearInterval(clock);
  }, [nativePane, webPaused, prompt, webStatus.left, webStatus.right]);

  useEffect(() => {
    setFirstTimedOut(false);
    if (!nativePane || (primary?.loaded && !primary.buffering) || prompt) return;
    const timer = window.setTimeout(() => setFirstTimedOut(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [session.loadId, nativePane, primary?.loaded, primary?.buffering, prompt]);

  useEffect(() => {
    setSecondTimedOut(false);
    if (!bothNative || (activeSecondary?.loaded && !activeSecondary.buffering) || prompt) return;
    const timer = window.setTimeout(() => setSecondTimedOut(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [paneId, bothNative, activeSecondary?.loaded, activeSecondary?.buffering, prompt]);

  const paused = nativePane ? !!primary?.paused : webPaused;
  const togglePause = () => {
    const next = !paused;
    if (nativePane) void playerSet('pause', next ? 'yes' : 'no');
    if (!bothNative) useLiveStore.setState({ webPaused: next });
  };
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
        togglePause();
      }
      if (event.code === 'KeyF') void toggleFullscreen();
      if (event.code === 'KeyM' && bothNative) void playerSet('mute', primary?.muted ? 'no' : 'yes');
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [paused, primary?.muted, prompt, bothNative, nativePane]);

  const chooseAudio = async (target: Side) => {
    if (changingAudio || target === audio) return;
    if (!bothNative) return setAudio(target);
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
  const nativeFailure = primaryError || (primary?.eof ? 'This stream ended.' : firstTimedOut ? 'This channel did not start in time.' : '');
  const secondFailure = secondError || (activeSecondary?.failed ? 'This stream could not be played.' : secondTimedOut ? 'This channel did not start in time.' : '');
  const webFailure = 'The web player didn’t answer.';
  const paneState = (side: Side) => {
    if (web[side]) return { error: webStatus[side] === 'failed' ? webFailure : '', buffering: !webPaused && webStatus[side] === 'loading' };
    if (side === nativePane) return { error: nativeFailure, buffering: !primary?.loaded || primary.buffering };
    return { error: secondFailure, buffering: !activeSecondary?.loaded || activeSecondary.buffering };
  };
  const retry = (side: Side) => {
    if (web[side]) setWebReload((r) => ({ ...r, [side]: r[side] + 1 }));
    else if (bothNative && side === 'right') setPaneId(crypto.randomUUID());
    else void switchPlayer(() => retryLiveMultiview(session));
  };

  return (
    <section className="fixed inset-0 z-[110] flex min-h-0 flex-col text-white" aria-label="Live TV multiview">
      <header className="flex items-center gap-4 border-b border-white/10 bg-nf-bg px-[4%] py-4">
        <button className={button} disabled={!!prompt} onClick={() => void closeBuiltin()} aria-label="Back to Live TV"><ArrowLeft className="h-5 w-5" /></button>
        <h1 className="flex-1 text-xl font-bold">Live TV multiview</h1>
        <button className={button} disabled={!!prompt} onClick={() => void toggleFullscreen()} aria-label="Toggle fullscreen" title="Toggle fullscreen (F)"><Maximize className="h-5 w-5" /></button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-2">
        {[
          { key: 'left' as const, name: session.title, subtitle: session.subtitle, ref: left },
          { key: 'right' as const, name: session.multiview.title, subtitle: session.multiview.subtitle, ref: right },
        ].map((pane) => {
          const isRight = pane.key === 'right';
          const player = web[pane.key];
          const { error, buffering } = paneState(pane.key);
          return (
            <div key={pane.key} className="flex min-h-0 min-w-0 flex-col border-r border-white/10 last:border-r-0">
              <div className={`flex items-center justify-between gap-3 border-b bg-nf-surface px-4 py-3 ${audio === pane.key ? 'border-nf-red' : 'border-white/10'}`}>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-bold" title={pane.name}>{pane.name}</h2>
                  <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-nf-secondary" title={pane.subtitle ?? undefined}>
                    {player && <Globe className="h-3 w-3 shrink-0" aria-hidden />}
                    <span className="truncate">{[pane.subtitle, player && 'Web player'].filter(Boolean).join(' · ')}</span>
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className={button}
                    onClick={() => void chooseAudio(pane.key)}
                    disabled={opening || changingAudio || (!player && buffering) || !!error || !!prompt}
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
                {player && !prompt && !webPaused && (
                  <LiveWebFrame
                    url={player.url}
                    title={`${pane.name} live`}
                    muted={audio !== pane.key}
                    compact
                    reload={webReload[pane.key]}
                    onStatus={(status) => setWebStatus((s) => (s[pane.key] === status ? s : { ...s, [pane.key]: status }))}
                    className="absolute inset-0 h-full w-full"
                  />
                )}
                {player && webPaused && !prompt && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black text-sm text-nf-secondary" role="status">Paused</div>
                )}
                {error ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 p-4 text-center">
                    <p className="text-sm" role="status">{error}</p>
                    <button className={button} disabled={opening || switching || !!prompt} onClick={() => retry(pane.key)}>
                      <RefreshCw className="h-4 w-4" /> {player || (bothNative && isRight) ? 'Retry channel' : 'Retry multiview'}
                    </button>
                  </div>
                ) : buffering && (
                  <div className={`pointer-events-none absolute inset-0 flex items-center justify-center ${player ? '' : 'bg-black/80'}`} role="status" aria-label={`Buffering ${pane.name}`}>
                    <Spinner className="h-8 w-8" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="flex items-center gap-3 border-t border-white/10 bg-nf-bg px-[4%] py-3">
        <button className={button} disabled={!!prompt} title={paused ? 'Resume both (Space)' : 'Pause both (Space)'} onClick={togglePause}>
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {paused ? 'Resume both' : 'Pause both'}
        </button>
        {bothNative && (
          <button
            className={button}
            disabled={!!prompt}
            aria-label={primary?.muted ? 'Unmute multiview' : 'Mute multiview'}
            title={primary?.muted ? 'Unmute (M)' : 'Mute (M)'}
            onClick={() => void playerSet('mute', primary?.muted ? 'no' : 'yes')}
          >
            {primary?.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        )}
        {nativePane && (
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
        )}
        <span className="min-w-0 truncate text-xs text-nf-secondary">Audio: {audio === 'left' ? session.title : session.multiview.title}</span>
      </footer>
      {prompt && (
        <div key={prompt} role="dialog" aria-modal="true" aria-label="Playback paused" className="absolute inset-0 z-20 flex items-center justify-center bg-black/75">
          <div className="rounded-lg bg-nf-surface p-8 text-center">
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
