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
  livePanes,
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
import useIdle from '../../hooks/useIdle';

function box(node: HTMLDivElement | null) {
  if (!node) return;
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  return {
    x: rect.left, y: rect.top, w: rect.width, h: rect.height,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  };
}

/**
 * Two to four channels in a grid. Each pane is native video (M3U channels) or a web player (web
 * channel lists). Two native channels share the native multiview; a single native channel is the
 * main player placed in its pane; web panes are frames. One channel is heard at a time.
 */
export default function LiveMultiview({ session }: { session: LivePlayerSession & { multiview: NonNullable<LivePlayerSession['multiview']> } }) {
  const primary = useLibraryStore((s) => s.playerState);
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const toast = useLibraryStore((s) => s.toast);
  const primaryError = useLiveStore((s) => s.playbackError);
  const secondary = useLiveStore((s) => s.multiviewState);
  const webPaused = useLiveStore((s) => s.webPaused);
  const panes = livePanes(session);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const natives = panes.flatMap((pane, index) => (pane.web ? [] : [index]));
  // The main native player shows `mainPane`; the native multiview view shows `secondPane`.
  const mainPane = natives[0] ?? -1;
  const secondPane = natives[1] ?? -1;
  const twoNative = secondPane >= 0;
  const { active, wake } = useIdle();
  const [paneId, setPaneId] = useState(() => crypto.randomUUID());
  const [opening, setOpening] = useState(twoNative);
  const [secondError, setSecondError] = useState('');
  const [firstTimedOut, setFirstTimedOut] = useState(false);
  const [secondTimedOut, setSecondTimedOut] = useState(false);
  const [audio, setAudio] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [webStatus, setWebStatus] = useState<Record<number, WebFrameStatus>>({});
  const [webReload, setWebReload] = useState<Record<number, number>>({});
  const activeSecondary = secondary?.loadId === session.loadId && secondary?.paneId === paneId ? secondary : null;
  const readLayout = (): MultiviewLayout | undefined => {
    const left = box(refs.current[mainPane]);
    const right = box(refs.current[secondPane]);
    if (left && right) return { left, right };
  };

  // Two native channels: open the second native view beside the main one.
  useEffect(() => {
    if (!twoNative) return;
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
    // Read the layout after React commits the panes. The playback service waits for the main
    // player, so both native views belong to this session even when Back is clicked during startup.
    const start = window.requestAnimationFrame(async () => {
      const layout = readLayout();
      if (!layout) {
        setSecondError('Could not size the video pane.');
        setOpening(false);
        return;
      }
      try {
        await openLiveMultiviewPane(session, paneId, layout);
      } catch (error) {
        if (!disposed) setSecondError(typeof error === 'string' ? error : 'This channel could not start.');
      } finally {
        if (!disposed) {
          setOpening(false);
          applyLayout();
        }
      }
    });
    const observer = new ResizeObserver(applyLayout);
    refs.current.forEach((node) => node && observer.observe(node));
    window.addEventListener('resize', applyLayout);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', applyLayout);
      window.cancelAnimationFrame(start);
      window.cancelAnimationFrame(frame);
    };
  }, [session.loadId, paneId, twoNative]);

  // One native channel: place the main player in its pane once it is running.
  useEffect(() => {
    if (twoNative || mainPane < 0 || !primary?.loaded) return;
    let frame = 0;
    const applyLayout = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = box(refs.current[mainPane]);
        if (rect) void invoke('player_layout', { rect }).catch(() => {});
      });
    };
    applyLayout();
    const observer = new ResizeObserver(applyLayout);
    const node = refs.current[mainPane];
    if (node) observer.observe(node);
    window.addEventListener('resize', applyLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', applyLayout);
      window.cancelAnimationFrame(frame);
    };
  }, [session.loadId, twoNative, mainPane, primary?.loaded]);

  // Only one channel is heard. Web panes reload muted or unmuted; native panes are muted or
  // given the audio track.
  useEffect(() => {
    if (mainPane < 0 || !primary?.loaded) return;
    const nativeHeard = audio === mainPane || audio === secondPane;
    if (twoNative && nativeHeard) {
      if (!activeSecondary?.loaded) return;
      void invoke('player_multiview_audio', { loadId: session.loadId, secondary: audio === secondPane })
        .catch(() => toast('Could not switch audio.', 'error'));
    }
    void playerSet('mute', nativeHeard ? 'no' : 'yes');
  }, [audio, mainPane, secondPane, twoNative, primary?.loaded, activeSecondary?.loaded, session.loadId]);

  // Watch time and limits when no native player is reporting.
  const anyWebReady = Object.values(webStatus).includes('ready');
  useEffect(() => {
    if (mainPane >= 0) return;
    const playing = !webPaused && !prompt && anyWebReady;
    const clock = window.setInterval(() => tickWebLive(playing), 1000);
    return () => window.clearInterval(clock);
  }, [mainPane, webPaused, prompt, anyWebReady]);

  useEffect(() => {
    setFirstTimedOut(false);
    if (mainPane < 0 || (primary?.loaded && !primary.buffering) || prompt) return;
    const timer = window.setTimeout(() => setFirstTimedOut(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [session.loadId, mainPane, primary?.loaded, primary?.buffering, prompt]);

  useEffect(() => {
    setSecondTimedOut(false);
    if (!twoNative || (activeSecondary?.loaded && !activeSecondary.buffering) || prompt) return;
    const timer = window.setTimeout(() => setSecondTimedOut(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [paneId, twoNative, activeSecondary?.loaded, activeSecondary?.buffering, prompt]);

  const hasWeb = natives.length < panes.length;
  const paused = mainPane >= 0 ? !!primary?.paused : webPaused;
  const togglePause = () => {
    const next = !paused;
    if (mainPane >= 0) void playerSet('pause', next ? 'yes' : 'no');
    if (hasWeb) useLiveStore.setState({ webPaused: next });
  };
  const back = async () => {
    const fullscreen = await getCurrentWindow().isFullscreen().catch(() => false);
    if (fullscreen) await toggleFullscreen();
    else await closeBuiltin();
  };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!isPlayerShortcut(event)) return;
      wake();
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
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [paused, prompt, mainPane, hasWeb]);

  const switchPlayer = async (action: () => void | Promise<void>) => {
    setSwitching(true);
    try { await action(); }
    finally { setSwitching(false); }
  };
  const nativeFailure = primaryError || (primary?.eof ? 'This stream ended.' : firstTimedOut ? 'This channel did not start in time.' : '');
  const secondFailure = secondError || (activeSecondary?.failed ? 'This stream could not be played.' : secondTimedOut ? 'This channel did not start in time.' : '');
  const paneState = (index: number) => {
    if (panes[index].web)
      return { error: webStatus[index] === 'failed' ? 'The web player didn’t answer.' : '', buffering: !webPaused && (webStatus[index] ?? 'loading') === 'loading' };
    if (index === mainPane) return { error: nativeFailure, buffering: !primary?.loaded || primary.buffering };
    return { error: secondFailure, buffering: !activeSecondary?.loaded || activeSecondary.buffering };
  };
  const retry = (index: number) => {
    if (panes[index].web) setWebReload((r) => ({ ...r, [index]: (r[index] ?? 0) + 1 }));
    else if (index === secondPane) setPaneId(crypto.randomUUID());
    else void switchPlayer(() => retryLiveMultiview(session));
  };
  const show = active || !!prompt;
  const fade = `transition-opacity duration-300 ${show ? 'opacity-100' : 'pointer-events-none opacity-0'}`;
  const grid = panes.length > 2;

  return (
    <section
      className={`fixed inset-0 z-[110] overflow-hidden text-white ${mainPane < 0 ? 'bg-black' : ''} ${show ? '' : 'cursor-none'}`}
      aria-label="Live TV multiview"
      onMouseMove={wake}
      onClick={wake}
    >
      <div className={`absolute inset-0 grid ${grid ? 'grid-cols-2 grid-rows-2' : 'grid-cols-2 grid-rows-1'}`}>
        {panes.map((pane, index) => {
          const { error, buffering } = paneState(index);
          const heard = audio === index;
          return (
            <div
              key={`${pane.playlistId}/${pane.id}`}
              ref={(node) => { refs.current[index] = node; }}
              // The window is see-through where native video sits behind it, so web panes and the
              // lines between panes must be painted solid or the desktop shows through.
              className={`relative min-h-0 min-w-0 border-black ${pane.web ? 'bg-black' : ''} ${index % 2 === 0 ? 'border-r-2' : ''} ${grid && index < 2 ? 'border-b-2' : ''}`}
            >
              {pane.web && !prompt && !webPaused && (
                <LiveWebFrame
                  url={pane.web.url}
                  title={`${pane.title} live`}
                  muted={!heard}
                  compact
                  reload={webReload[index] ?? 0}
                  onStatus={(status) => setWebStatus((s) => (s[index] === status ? s : { ...s, [index]: status }))}
                  className="absolute inset-0 h-full w-full"
                />
              )}
              {pane.web && webPaused && !prompt && (
                <div className="absolute inset-0 flex items-center justify-center bg-black text-sm text-nf-secondary" role="status">Paused</div>
              )}
              {error ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/90 p-4 text-center">
                  <p className="text-sm" role="status">{error}</p>
                  <button className={button} disabled={opening || switching || !!prompt} onClick={() => retry(index)}>
                    <RefreshCw className="h-4 w-4" /> {pane.web || index === secondPane ? 'Retry channel' : 'Retry multiview'}
                  </button>
                </div>
              ) : buffering && (
                <div className={`pointer-events-none absolute inset-0 flex items-center justify-center ${pane.web ? '' : 'bg-black/80'}`} role="status" aria-label={`Buffering ${pane.title}`}>
                  <Spinner className="h-8 w-8" />
                </div>
              )}
              <PaneBar
                top={grid ? index < 2 : true}
                className={fade}
                name={pane.title}
                subtitle={[pane.subtitle, pane.web && 'Web player'].filter(Boolean).join(' · ')}
                web={!!pane.web}
                heard={heard}
                disabled={!!prompt}
                busy={switching}
                onListen={() => setAudio(index)}
                onSolo={() => void switchPlayer(() => watchLivePane(session, index))}
              />
            </div>
          );
        })}
        {panes.length === 3 && <div className="bg-black" aria-hidden />}
      </div>
      {/* Wakes the controls (and shows the cursor) on the first move over a web player. */}
      {!show && <div className="absolute inset-0 z-30 cursor-none" onMouseMove={wake} onMouseDown={wake} aria-hidden />}
      <header className={`absolute inset-x-0 top-0 z-20 flex items-center gap-4 bg-gradient-to-b from-black/90 to-transparent px-[4%] pb-8 pt-4 ${fade}`}>
        <button className={button} disabled={!!prompt} onClick={() => void closeBuiltin()} aria-label="Back to Live TV"><ArrowLeft className="h-5 w-5" /></button>
        <h1 className="flex-1 text-xl font-bold">Live TV multiview</h1>
        <button className={button} disabled={!!prompt} onClick={() => void toggleFullscreen()} aria-label="Toggle fullscreen" title="Toggle fullscreen (F)"><Maximize className="h-5 w-5" /></button>
      </header>
      <footer className={`absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 bg-gradient-to-t from-black/90 to-transparent px-[4%] pb-4 pt-8 ${fade}`}>
        <button className={button} disabled={!!prompt} title={paused ? 'Resume all (Space)' : 'Pause all (Space)'} onClick={togglePause}>
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {paused ? 'Resume all' : 'Pause all'}
        </button>
        {mainPane >= 0 && (
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
        <span className="min-w-0 truncate text-xs text-nf-secondary">Audio: {panes[audio]?.title}</span>
      </footer>
      {prompt && (
        <div key={prompt} role="dialog" aria-modal="true" aria-label="Playback paused" className="absolute inset-0 z-40 flex items-center justify-center bg-black/75">
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

function PaneBar(props: {
  top: boolean;
  className: string;
  name: string;
  subtitle: string;
  web: boolean;
  heard: boolean;
  disabled: boolean;
  busy: boolean;
  onListen: () => void;
  onSolo: () => void;
}) {
  const { top, className, name, subtitle, web, heard, disabled, busy, onListen, onSolo } = props;
  return (
    // Panes in the top row sit below the window's title bar.
    <div className={`absolute inset-x-3 z-20 flex items-center justify-between gap-3 rounded bg-black/70 px-3 py-2 ${top ? 'top-20' : 'top-3'} ${heard ? 'ring-1 ring-nf-red' : ''} ${className}`}>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-bold" title={name}>{name}</h2>
        <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-nf-secondary" title={subtitle}>
          {web && <Globe className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="truncate">{subtitle}</span>
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          className={button}
          onClick={onListen}
          disabled={disabled}
          aria-pressed={heard}
          aria-label={`Listen to ${name}`}
          title={heard ? 'Audio selected' : 'Listen to this channel'}
        >
          {heard ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </button>
        <button className={button} aria-label={`Watch ${name} alone`} title="Watch this channel alone" disabled={busy || disabled} onClick={onSolo}>
          <SquarePlay className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

