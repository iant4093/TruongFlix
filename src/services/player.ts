import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLibraryStore } from '../store/useLibraryStore';
import { episodeTarget, playTargetFor } from '../store/selectors';
import type {
  BuiltinPlayerState,
  EngineStatus,
  EpisodeRow,
  MediaItem,
  PlayableType,
  PlayerSession,
  PlayerTrack,
  PlayTarget,
} from '../types/media';
import { getSelectedSubtitlePath, recordProgress } from './db';
import { subtitlesEnabled } from './subtitles';

interface ProgressPayload {
  media_type: PlayableType;
  media_id: number;
  time: number;
  length: number;
}

interface ExitedPayload {
  media_type: PlayableType;
  media_id: number;
  final_time: number;
  length: number;
}

export async function detectVlc(): Promise<string | null> {
  return invoke<string | null>('detect_vlc');
}

export async function installVlc(): Promise<string | null> {
  return invoke<string | null>('install_vlc');
}

let statusPromise: Promise<EngineStatus> | null = null;

/** Whether the built-in (mpv) engine can run on this machine. Cached for the session. */
export function engineStatus(): Promise<EngineStatus> {
  statusPromise ??= invoke<EngineStatus>('player_status').catch((e) => ({
    available: false,
    reason: String(e),
    mpv_version: null,
    ffmpeg_version: null,
    library: null,
  }));
  return statusPromise;
}

async function subtitleFor(target: PlayTarget) {
  const { settings } = useLibraryStore.getState();
  if (!subtitlesEnabled(settings)) return null;
  return getSelectedSubtitlePath(target.type, target.id).catch(() => null);
}

/** Plays a movie/episode in the built-in player when available, otherwise in VLC. */
export async function play(target: PlayTarget) {
  const { settings } = useLibraryStore.getState();
  if (settings.player_engine !== 'vlc') {
    const status = await engineStatus();
    if (status.available) return playBuiltin(target);
  }
  return playInVlc(target);
}

/** Launches external VLC, resuming from `startTime` seconds. */
export async function playInVlc(target: PlayTarget) {
  const store = useLibraryStore.getState();
  try {
    const subtitlePath = await subtitleFor(target);
    await invoke('launch_vlc', {
      filePath: target.filePath,
      startTime: Math.max(0, Math.floor(target.startTime)),
      mediaType: target.type,
      mediaId: target.id,
      vlcPath: store.settings.vlc_executable_path || null,
      subtitlePath,
    });
    store.setPlayback({ active: true, type: target.type, id: target.id, time: target.startTime, length: 0 });
    store.setHover(null);
    store.toast(
      `${target.startTime > 0 ? 'Resuming' : 'Playing'} ${target.label} in VLC${subtitlePath ? ' with subtitles' : ''}`,
      'info',
    );
  } catch (e) {
    store.toast(String(e), 'error');
  }
}

export function playItem(item: MediaItem) {
  const { episodesBySeries, toast } = useLibraryStore.getState();
  const target = playTargetFor(item, episodesBySeries);
  if (!target) return toast(`No playable file found for “${item.title}”`, 'error');
  return play(target);
}

export function playEpisode(ep: EpisodeRow, series: { title: string }) {
  return play(episodeTarget(ep, series));
}

export async function stopPlayback() {
  await invoke('stop_vlc');
}

// ---------------------------------------------------------------------------
// Built-in player
// ---------------------------------------------------------------------------

/** Titles, artwork and the "next episode" for the player chrome. */
function describe(target: PlayTarget): PlayerSession {
  const { items, episodes, episodesBySeries } = useLibraryStore.getState();
  if (target.type === 'movie') {
    const item = items.find((i) => i.kind === 'movie' && i.id === target.id) ?? null;
    return {
      target,
      itemKey: item?.key ?? null,
      title: item?.title ?? target.label,
      subtitle: null,
      overview: item?.overview ?? null,
      logo: item?.logo ?? null,
      next: null,
      nextLabel: null,
    };
  }
  const ep = episodes.find((e) => e.id === target.id);
  const series = ep ? items.find((i) => i.kind === 'tv' && i.id === ep.series_id) : undefined;
  const list = ep ? (episodesBySeries.get(ep.series_id) ?? []) : [];
  const idx = ep ? list.findIndex((e) => e.id === ep.id) : -1;
  const nextEp = idx >= 0 ? list.slice(idx + 1).find((e) => e.season_number > 0) : undefined;
  const title = series?.title ?? target.label;
  return {
    target,
    itemKey: series?.key ?? null,
    title,
    subtitle: ep ? `S${ep.season_number}:E${ep.episode_number} · ${ep.title}` : null,
    overview: ep?.overview || series?.overview || null,
    logo: series?.logo ?? null,
    next: nextEp ? { ...episodeTarget(nextEp, { title }), startTime: 0 } : null,
    nextLabel: nextEp ? `S${nextEp.season_number}:E${nextEp.episode_number} · ${nextEp.title}` : null,
  };
}

/** Saves the current position of the built-in player's item (resume point / watched). */
async function saveBuiltinProgress() {
  const { playerSession, playerState, patchProgress } = useLibraryStore.getState();
  if (!playerSession || !playerState?.loaded || !playerState.duration) return;
  const { type, id } = playerSession.target;
  const time = playerState.eof ? playerState.duration : playerState.time;
  await recordProgress(type, id, time, playerState.duration).catch(() => {});
  patchProgress(type, id, time, playerState.duration);
}

/** Opens (or switches the running player to) a movie/episode inside the TruongFlix window. */
export async function playBuiltin(target: PlayTarget) {
  const store = useLibraryStore.getState();
  if (store.playerSession) await saveBuiltinProgress();
  store.setPlayerSession(describe(target));
  store.setPlayerState(null);
  store.setPlayerTracks([]);
  try {
    await invoke('player_open', {
      filePath: target.filePath,
      startTime: Math.max(0, target.startTime),
      subtitlePath: await subtitleFor(target),
      audioLang: null,
      subLang: null,
    });
  } catch (e) {
    store.setPlayerSession(null);
    store.toast(`Built-in player couldn’t start (${String(e)}). Opening in VLC instead.`, 'error');
    await playInVlc(target);
  }
}

let enteredFullscreen = false;

export async function toggleFullscreen() {
  const win = getCurrentWindow();
  const fs = await win.isFullscreen();
  await win.setFullscreen(!fs);
  enteredFullscreen = !fs;
  return !fs;
}

/** Stops the built-in player and returns to the library. */
export async function closeBuiltin() {
  const store = useLibraryStore.getState();
  if (!store.playerSession) return;
  await saveBuiltinProgress();
  try {
    await invoke('player_close');
  } catch (e) {
    console.warn('[player] close failed', e);
  }
  finishSession();
}

function finishSession() {
  const store = useLibraryStore.getState();
  if (!store.playerSession) return;
  store.setPlayerSession(null);
  store.setPlayerState(null);
  store.setPlayerTracks([]);
  if (enteredFullscreen) {
    enteredFullscreen = false;
    void getCurrentWindow().setFullscreen(false);
  }
  void store.reload();
}

/** Hands the current item to external VLC at the same position. */
export async function openCurrentInVlc() {
  const { playerSession, playerState } = useLibraryStore.getState();
  if (!playerSession) return;
  const target = { ...playerSession.target, startTime: playerState?.time ?? playerSession.target.startTime };
  await closeBuiltin();
  await playInVlc(target);
}

export const playerCommand = (...args: (string | number)[]) =>
  invoke('player_command', { args: args.map(String) }).catch((e) => console.warn('[player]', e));
export const playerSet = (name: string, value: string | number) =>
  invoke('player_set', { name, value: String(value) }).catch((e) => console.warn('[player]', e));

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let unlisteners: UnlistenFn[] = [];
let lastSave = 0;

/** Subscribes to VLC and built-in player events and persists watch state in real time. */
export async function initPlayerEvents() {
  if (unlisteners.length) return;
  unlisteners = await Promise.all([
    listen<ProgressPayload>('vlc-progress', async ({ payload }) => {
      const store = useLibraryStore.getState();
      store.setPlayback({ active: true, type: payload.media_type, id: payload.media_id, time: payload.time, length: payload.length });
      try {
        await recordProgress(payload.media_type, payload.media_id, payload.time, payload.length);
        store.patchProgress(payload.media_type, payload.media_id, payload.time, payload.length);
      } catch (e) {
        console.warn('[player] progress save failed', e);
      }
    }),
    listen<ExitedPayload>('vlc-exited', async ({ payload }) => {
      const store = useLibraryStore.getState();
      try {
        await recordProgress(payload.media_type, payload.media_id, payload.final_time, payload.length);
      } catch (e) {
        console.warn('[player] final save failed', e);
      }
      store.setPlayback({ active: false, type: null, id: null, time: 0, length: 0 });
      await store.reload();
    }),

    listen<BuiltinPlayerState>('player-state', ({ payload }) => {
      const store = useLibraryStore.getState();
      if (!store.playerSession) return;
      store.setPlayerState(payload);
      // Persist the resume point every few seconds (and right away at the end).
      if (payload.loaded && payload.duration > 0 && (payload.eof || Date.now() - lastSave > 5000)) {
        lastSave = Date.now();
        void saveBuiltinProgress();
      }
    }),
    listen<string>('player-tracks', ({ payload }) => {
      try {
        useLibraryStore.getState().setPlayerTracks(JSON.parse(payload) as PlayerTrack[]);
      } catch {
        /* ignore malformed track lists */
      }
    }),
    listen<{ message: string }>('player-error', ({ payload }) => {
      const store = useLibraryStore.getState();
      store.toast(`Playback error: ${payload.message}`, 'error');
      if (!store.playerState?.loaded) void closeBuiltin();
    }),
    listen('player-closed', () => finishSession()),
  ]);
}

export function disposePlayerEvents() {
  unlisteners.forEach((u) => u());
  unlisteners = [];
}
