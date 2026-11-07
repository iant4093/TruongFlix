import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Maximize,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  Settings2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { LivePlayerSession } from '../../types/live';
import type { AudioDevice } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import Spinner from '../common/Spinner';
import {
  closeBuiltin,
  dismissPrompt,
  enterMini,
  goLive,
  listAudioDevices,
  playerCommand,
  playerSet,
  retuneLive,
  seekLive,
  setAudioDevice,
  setSleepTimer,
  toggleFullscreen,
} from '../../services/player';
import { useLiveStore } from '../../services/live';
import { languageName } from '../../services/subtitles';
import Dropdown from '../common/Dropdown';
import { isPlayerShortcut, playerControlTitles } from '../player/shortcuts';
import LiveMultiview from './LiveMultiview';
import { getCurrentWindow } from '@tauri-apps/api/window';

const control =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:bg-white/15 disabled:opacity-30';

export default function LivePlayer({ session }: { session: LivePlayerSession }) {
  if (session.multiview) {
    return <LiveMultiview key={session.loadId} session={{ ...session, multiview: session.multiview }} />;
  }
  return <SingleLivePlayer session={session} />;
}

function SingleLivePlayer({ session }: { session: LivePlayerSession }) {
  const state = useLibraryStore((s) => s.playerState);
  const mini = useLibraryStore((s) => s.playerMini);
  const tracks = useLibraryStore((s) => s.playerTracks);
  const prompt = useLibraryStore((s) => s.playerPrompt);
  const sleep = useLibraryStore((s) => s.sleepTimer);
  const error = useLiveStore((s) => s.playbackError);
  const [visible, setVisible] = useState(true);
  const [settings, setSettings] = useState(false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const output = useLibraryStore((s) => s.settings.audio_device);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const hide = useRef<number>();
  const range = state?.seekable_ranges?.find((r) => state.time >= r.start - 1 && state.time <= r.end + 1);
  const behind = range && state ? Math.max(0, range.end - state.time) : 0;
  const fresh = !state?.cache_updated_at || now - state.cache_updated_at < 15_000;
  const interrupted = !!error || !!state?.eof;
  const blocked = !!prompt;
  const buffering = !state?.loaded || state.buffering;
  const reveal = () => {
    setVisible(true);
    window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setVisible(false), 3000);
  };
  useEffect(() => {
    reveal();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(hide.current);
      window.clearInterval(clock);
    };
  }, []);
  useEffect(() => {
    setAttempt(0);
  }, [session.target.id]);
  useEffect(() => {
    if ((state?.loaded && !state.buffering) || blocked) return;
    const timer = window.setTimeout(
      () => useLiveStore.setState({ playbackError: 'The channel did not start in time.' }),
      20_000,
    );
    return () => window.clearTimeout(timer);
  }, [session.loadId, state?.loaded, state?.buffering, blocked]);
  useEffect(() => {
    if (!interrupted || attempt >= 3 || blocked) return;
    const timer = window.setTimeout(() => {
      setAttempt((n) => n + 1);
      void retuneLive();
    }, [2000, 5000, 10_000][attempt]);
    return () => window.clearTimeout(timer);
  }, [interrupted, attempt, blocked]);
  useEffect(() => {
    if (!state?.loaded || state.eof || state.buffering || state.paused) return;
    const timer = window.setTimeout(() => setAttempt(0), 30_000);
    return () => window.clearTimeout(timer);
  }, [session.loadId, state?.loaded, state?.eof, state?.buffering, state?.paused]);
  useEffect(() => {
    if (settings)
      void listAudioDevices()
        .then(setDevices)
        .catch(() => {});
  }, [settings]);
  useEffect(() => {
    if (mini) return;
    const key = (event: KeyboardEvent) => {
      if (!isPlayerShortcut(event)) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (settings) setSettings(false);
        else
          void getCurrentWindow()
            .isFullscreen()
            .then(async (fullscreen) => {
              if (fullscreen) await toggleFullscreen();
              else await closeBuiltin();
            });
        return;
      }
      reveal();
      if (blocked) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void playerCommand('cycle', 'pause');
      }
      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        void seekLive(-10);
      }
      if (event.code === 'ArrowRight') {
        event.preventDefault();
        void seekLive(10);
      }
      if (event.code === 'PageUp') {
        event.preventDefault();
        void retuneLive(-1);
      }
      if (event.code === 'PageDown') {
        event.preventDefault();
        void retuneLive(1);
      }
      if (event.code === 'KeyF') void toggleFullscreen();
      if (event.code === 'KeyM') void playerCommand('cycle', 'mute');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [blocked, settings, mini]);
  const show = visible || settings || state?.paused || blocked || interrupted || buffering;
  const chromeOpacity = show ? 'opacity-100' : 'opacity-0 has-[:focus-visible]:opacity-100 has-[:focus-visible]:transition-none';
  const chromePointer = show ? 'pointer-events-auto' : 'group-has-[:focus-visible]/live-chrome:pointer-events-auto';
  const audio = tracks.filter((t) => t.type === 'audio');
  const subs = tracks.filter((t) => t.type === 'sub');
  if (mini) return null;
  return (
    <div
      className={`fixed inset-0 z-[110] text-white ${show ? '' : 'cursor-none has-[:focus-visible]:cursor-auto'}`}
      onMouseMove={reveal}
      onClick={reveal}
    >
      <div
        hidden={blocked}
        className={`absolute inset-x-0 top-0 z-10 items-center gap-5 bg-gradient-to-b from-black/85 to-transparent px-[4%] pb-16 pt-6 transition-opacity ${blocked ? 'hidden' : 'flex'} ${chromeOpacity} ${show ? '' : 'pointer-events-none has-[:focus-visible]:pointer-events-auto'}`}
      >
        <button className={control} aria-label="Back to Live TV" onClick={() => void closeBuiltin()}>
          <ArrowLeft />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="rounded bg-nf-red px-2 py-0.5 text-[10px] font-bold tracking-widest">LIVE TV</span>
            <h1 className="truncate text-xl font-bold">{session.title}</h1>
          </div>
          {session.subtitle && <p className="mt-1 truncate text-sm text-white/60">{session.subtitle}</p>}
        </div>
      </div>
      {blocked ? (
        <div key={prompt} role="dialog" aria-modal="true" aria-label="Playback paused" className="absolute inset-0 z-20 flex items-center justify-center bg-black/70">
          <div className="rounded-lg bg-nf-surface p-8 text-center">
            <h2 className="mb-4 text-2xl font-bold">
              {prompt === 'limit'
                ? 'That’s all for today!'
                : prompt === 'bedtime'
                  ? 'It’s bedtime'
                  : 'Sleep timer ended'}
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
      ) : interrupted ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="max-w-md rounded-lg bg-nf-surface/95 p-8 text-center">
            <RadioIcon />
            <h2 className="mt-4 text-xl font-bold">Channel interrupted</h2>
            <p className="mt-2 text-sm text-white/60">
              {error || 'The stream ended unexpectedly.'}{' '}
              {attempt < 3 ? 'Reconnecting…' : 'Try again or choose another channel.'}
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button
                className="nf-btn-red"
                onClick={() => {
                  setAttempt(0);
                  void retuneLive();
                }}
              >
                <RefreshCw className="h-4 w-4" /> Retry
              </button>
              <button className="nf-btn-ghost" onClick={() => void retuneLive(1)}>
                Next channel
              </button>
            </div>
          </div>
        </div>
      ) : (
        buffering && (
          <div
            role="status"
            aria-label="Buffering live stream"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <Spinner className="h-12 w-12" />
          </div>
        )
      )}
      <div
        hidden={blocked}
        className={`group/live-chrome pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-[4%] pb-7 pt-20 transition-opacity ${blocked ? 'hidden' : chromeOpacity}`}
      >
        {!blocked && settings && (
          <div className="pointer-events-auto ml-auto mb-5 w-96 max-w-full space-y-4 rounded-lg border border-white/15 bg-nf-surface p-5 shadow-xl">
            <div className="flex items-center justify-between font-bold">
              Live playback
              <button aria-label="Close playback settings" onClick={() => setSettings(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              Audio
              <Dropdown
                value={audio.find((t) => t.selected)?.id ?? 0}
                options={
                  audio.length
                    ? audio.map((t) => ({
                        value: t.id,
                        label: t.title || languageName(t.lang || '') || `Audio ${t.id}`,
                      }))
                    : [{ value: 0, label: 'No audio tracks' }]
                }
                onChange={(id) => void playerSet('aid', id)}
                ariaLabel="Live audio track"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              Subtitles
              <Dropdown
                value={subs.find((t) => t.selected)?.id ?? -1}
                options={[
                  { value: -1, label: 'Off' },
                  ...subs.map((t) => ({
                    value: t.id,
                    label: t.title || languageName(t.lang || '') || `Subtitle ${t.id}`,
                  })),
                ]}
                onChange={(id) => void playerSet('sid', id === -1 ? 'no' : id)}
                ariaLabel="Live subtitle track"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              Speakers
              <Dropdown
                value={output || 'auto'}
                options={[
                  { value: 'auto', label: 'System default' },
                  ...devices
                    .filter((d) => d.name !== 'auto')
                    .map((d) => ({ value: d.name, label: d.description || d.name })),
                ]}
                onChange={(name) => void setAudioDevice(name)}
                ariaLabel="Live audio output"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              Sleep timer
              <Dropdown
                value={sleep?.mode === 'minutes' ? sleep.minutes : 0}
                options={[
                  { value: 0, label: 'Off' },
                  ...[15, 30, 60, 90].map((value) => ({ value, label: `${value} minutes` })),
                ]}
                onChange={(value) => setSleepTimer(value || null)}
                ariaLabel="Live sleep timer"
              />
            </label>
            <p className="text-xs text-white/40">
              Rewind is limited to the available live buffer. Page Up/Down changes channels.
            </p>
          </div>
        )}
        <div className={`mb-4 flex items-center gap-4 ${chromePointer}`}>
          <button
            className={`shrink-0 text-xs font-bold tracking-wide ${fresh && !state?.paused && behind < 5 ? 'text-red-400' : 'text-white'}`}
            onClick={() => void goLive()}
            aria-label="Go live"
          >
            ● {fresh && !state?.paused && behind < 5 ? 'LIVE' : 'GO LIVE'}
          </button>
          {range && state && range.end - range.start > 2 ? (
            <>
              <input
                type="range"
                aria-label="Live buffer position"
                className="h-1 flex-1 accent-nf-red"
                min={range.start}
                max={range.end}
                step={0.5}
                value={Math.max(range.start, Math.min(range.end, state.time))}
                disabled={blocked}
                onChange={(e) => void playerCommand('seek', e.target.value, 'absolute+exact')}
              />
              <span className="text-xs tabular-nums text-white/60">
                {!fresh
                  ? 'Reconnect to live edge'
                  : behind < 5
                    ? 'At live edge'
                    : `${Math.floor(behind / 60)}:${String(Math.floor(behind % 60)).padStart(2, '0')} behind`}
              </span>
            </>
          ) : (
            <span className="text-xs text-white/40">Live stream · Rewind becomes available when buffered</span>
          )}
        </div>
        <div className={`flex items-center gap-3 ${chromePointer}`}>
          <button
            className={control}
            disabled={blocked}
            aria-label={state?.paused ? 'Resume live TV' : 'Pause live TV'}
            title={state?.paused ? playerControlTitles.play : playerControlTitles.pause}
            onClick={() => void playerCommand('cycle', 'pause')}
          >
            {state?.paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
          </button>
          <button
            className={control}
            disabled={blocked || !range}
            aria-label="Rewind live TV 10 seconds"
            title={playerControlTitles.rewind}
            onClick={() => void seekLive(-10)}
          >
            <span className="text-sm font-bold">−10</span>
          </button>
          <button
            className={control}
            disabled={blocked || !range}
            aria-label="Forward live TV 10 seconds"
            title={playerControlTitles.forward}
            onClick={() => void seekLive(10)}
          >
            <span className="text-sm font-bold">+10</span>
          </button>
          <button className={control} aria-label={state?.muted ? 'Unmute live TV' : 'Mute live TV'} title={state?.muted ? playerControlTitles.unmute : playerControlTitles.mute} onClick={() => void playerCommand('cycle', 'mute')}>
            {state?.muted ? <VolumeX /> : <Volume2 />}
          </button>
          <input
            aria-label="Live TV volume"
            type="range"
            min={0}
            max={100}
            value={state?.volume ?? 100}
            onChange={(e) => void playerSet('volume', e.target.value)}
            className="w-20 accent-white"
          />
          <span className="flex-1" />
          <button
            className={control}
            disabled={blocked}
            aria-label="Previous channel"
            onClick={() => void retuneLive(-1)}
          >
            <ChevronUp />
          </button>
          <button className={control} disabled={blocked} aria-label="Next channel" onClick={() => void retuneLive(1)}>
            <ChevronDown />
          </button>
          <button className={control} aria-label="Live playback settings" onClick={() => setSettings(!settings)}>
            <Settings2 />
          </button>
          <button className={control} aria-label="Live mini-player" onClick={() => void enterMini()}>
            <PictureInPicture2 />
          </button>
          <button className={control} aria-label="Toggle live fullscreen" title="Toggle fullscreen (F)" onClick={() => void toggleFullscreen()}>
            <Maximize />
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioIcon() {
  return (
    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
      <RefreshCw className="h-5 w-5 text-white/60" />
    </div>
  );
}
