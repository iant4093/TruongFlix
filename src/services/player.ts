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
  Settings,
  SubtitleStyle,
} from '../types/media';
import { getSelectedSubtitlePath, logWatchTime, recordProgress } from './db';
import { parseMediaInfo } from './mediainfo';
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

const IS_MAC = navigator.userAgent.includes('Mac');

function mediaInfoFor(target: PlayTarget) {
  const { movies, episodes } = useLibraryStore.getState();
  const row = target.type === 'movie' ? movies.find((m) => m.id === target.id) : episodes.find((e) => e.id === target.id);
  return parseMediaInfo(row?.media_info);
}

/** Plays a movie/episode in the built-in player when available, otherwise in VLC. */
export async function play(target: PlayTarget) {
  const { settings, toast } = useLibraryStore.getState();
  if (settings.player_engine !== 'vlc') {
    const status = await engineStatus();
    if (status.available) {
      // mpv's embedded renderer on macOS doesn't reshape Dolby Vision profile 5 (no HDR10 base layer).
      if (IS_MAC && mediaInfoFor(target)?.dv_profile === 5) {
        toast('This file is Dolby Vision profile 5 — colours may look off in the built-in player on macOS.', 'info');
      }
      return playBuiltin(target);
    }
  }
  return playInVlc(target);
}

// ---------------------------------------------------------------------------
// Subtitle appearance & audio filters
// ---------------------------------------------------------------------------

const SUB_SIZES: Record<SubtitleStyle['size'], number> = { small: 36, medium: 46, large: 58, xlarge: 72 };
const SUB_COLORS: Record<SubtitleStyle['color'], string> = {
  white: '#FFFFFF',
  yellow: '#FFE600',
  cyan: '#3DE1FF',
  green: '#4CFF6B',
  magenta: '#FF5CF2',
};
const SUB_FONTS: Record<SubtitleStyle['font'], string> = {
  sans: IS_MAC ? 'Helvetica Neue' : 'Segoe UI Semibold',
  serif: 'Georgia',
  mono: IS_MAC ? 'Menlo' : 'Consolas',
};

/** mpv options for the Netflix-style subtitle settings (applies to plain-text subtitles). */
export function subtitleOptions(style: SubtitleStyle): [string, string][] {
  const base: [string, string][] = [
    ['sub-font-size', String(SUB_SIZES[style.size])],
    ['sub-color', SUB_COLORS[style.color]],
    ['sub-font', SUB_FONTS[style.font]],
  ];
  switch (style.background) {
    case 'none':
      return [...base, ['sub-border-style', 'outline-and-shadow'], ['sub-outline-size', '1.2'], ['sub-outline-color', '#000000'], ['sub-shadow-offset', '0']];
    case 'shadow':
      return [...base, ['sub-border-style', 'outline-and-shadow'], ['sub-outline-size', '2.5'], ['sub-outline-color', '#000000'], ['sub-back-color', '#80000000'], ['sub-shadow-offset', '1.5']];
    case 'translucent':
      return [...base, ['sub-border-style', 'opaque-box'], ['sub-outline-size', '6'], ['sub-outline-color', '#A0000000'], ['sub-shadow-offset', '0']];
    case 'solid':
      return [...base, ['sub-border-style', 'opaque-box'], ['sub-outline-size', '6'], ['sub-outline-color', '#FF000000'], ['sub-shadow-offset', '0']];
  }
}

/**
 * Night mode levels loudness (quiet dialogue up, explosions down). Dialogue boost lifts the centre
 * channel on surround tracks, or the speech frequencies on stereo ones.
 */
export function audioFilterChain(settings: Pick<Settings, 'audio_night' | 'audio_dialogue'>, channels: number): string {
  const chain: string[] = [];
  if (settings.audio_dialogue) {
    chain.push(
      channels >= 6
        ? '@dialogue:lavfi=[pan=stereo|FL=FC+0.30*FL+0.30*SL+0.30*BL|FR=FC+0.30*FR+0.30*SR+0.30*BR]'
        : '@dialogue:lavfi=[highpass=f=90,equalizer=f=2500:t=q:w=1.1:g=5,equalizer=f=200:t=q:w=1:g=-2]',
    );
  }
  if (settings.audio_night) chain.push('@night:lavfi=[dynaudnorm=f=200:g=15:p=0.9:m=8]');
  return chain.join(',');
}

const selectedChannels = (tracks: PlayerTrack[]) => {
  const t = tracks.find((x) => x.type === 'audio' && x.selected);
  return t?.['demux-channel-count'] ?? t?.['audio-channels'] ?? 2;
};

let appliedAf = '';

/** Re-applies audio filters when the setting or the selected audio track changes. */
export function syncAudioFilters() {
  const { settings, playerSession, playerTracks } = useLibraryStore.getState();
  if (!playerSession) return;
  const af = audioFilterChain(settings, selectedChannels(playerTracks));
  if (af === appliedAf) return;
  appliedAf = af;
  void playerSet('af', af);
}

/** Live-updates subtitle appearance while playing. */
export function syncSubtitleStyle() {
  const { settings, playerSession } = useLibraryStore.getState();
  if (!playerSession) return;
  for (const [k, v] of subtitleOptions(settings.subtitle_style)) void playerSet(k, v);
}

// ---------------------------------------------------------------------------
// Watch time (Viewing Activity / Wrapped)
// ---------------------------------------------------------------------------

let tick: { type: string; id: number; time: number; wall: number } | null = null;
let pendingSeconds = 0;

/** Counts only naturally watched time: no seeks, pauses or idle stretches. */
function countWatchTime(type: PlayableType, id: number, time: number, speed = 1) {
  const now = Date.now();
  if (tick && tick.type === type && tick.id === id) {
    const dt = time - tick.time;
    const wall = (now - tick.wall) / 1000;
    if (dt > 0 && dt <= wall * Math.max(speed, 1) + 2 && dt < 60) pendingSeconds += dt;
  } else {
    void flushWatchTime();
  }
  tick = { type, id, time, wall: now };
}

async function flushWatchTime() {
  const seconds = pendingSeconds;
  const current = tick;
  pendingSeconds = 0;
  if (!current || seconds < 1) return;
  const { movies, episodes, series, items } = useLibraryStore.getState();
  if (current.type === 'movie') {
    const m = movies.find((x) => x.id === current.id);
    if (!m) return;
    const item = items.find((i) => i.kind === 'movie' && i.versions.some((v) => v.id === m.id));
    await logWatchTime('movie', m.id, seconds, {
      title: m.title, series_id: null, series_title: null, genres: item?.genres ?? [], season: null, episode: null, poster: m.poster_path,
    }).catch(() => {});
  } else {
    const e = episodes.find((x) => x.id === current.id);
    const s = e ? series.find((x) => x.id === e.series_id) : undefined;
    if (!e || !s) return;
    const item = items.find((i) => i.kind === 'tv' && i.id === s.id);
    await logWatchTime('episode', e.id, seconds, {
      title: e.title, series_id: s.id, series_title: s.title, genres: item?.genres ?? [], season: e.season_number, episode: e.episode_number, poster: s.poster_path,
    }).catch(() => {});
  }
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
  if (store.playerSession) {
    await saveBuiltinProgress();
    await flushWatchTime();
  }
  store.setPlayerSession(describe(target));
  store.setPlayerState(null);
  store.setPlayerTracks([]);
  store.setPlayerChapters([]);
  try {
    const { settings } = useLibraryStore.getState();
    appliedAf = audioFilterChain(settings, mediaInfoFor(target)?.audio.find((a) => a.default)?.channels ?? 2);
    await invoke('player_open', {
      filePath: target.filePath,
      startTime: Math.max(0, target.startTime),
      subtitlePath: await subtitleFor(target),
      audioLang: null,
      subLang: null,
      options: [...subtitleOptions(settings.subtitle_style), ['af', appliedAf]],
    });
    // Keep the video surface in sync with the UI (e.g. the next episode starting inside the mini-player).
    const mini = useLibraryStore.getState().playerMini;
    await invoke('player_layout', { rect: mini ? miniRect() : null }).catch(() => {});
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
  await flushWatchTime();
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
  tick = null;
  store.setPlayerMini(false);
  store.setPlayerSession(null);
  store.setPlayerState(null);
  store.setPlayerTracks([]);
  if (enteredFullscreen) {
    enteredFullscreen = false;
    void getCurrentWindow().setFullscreen(false);
  }
  void store.reload();
}

// ---------------------------------------------------------------------------
// Mini-player
// ---------------------------------------------------------------------------

export const MINI = { width: 400, margin: 24, bar: 64 };

/** Where the mini video sits (CSS px): bottom-right, above its control bar. */
export function miniRect() {
  const w = Math.min(MINI.width, Math.round(window.innerWidth * 0.36));
  const h = Math.round((w * 9) / 16);
  return { x: window.innerWidth - MINI.margin - w, y: window.innerHeight - MINI.margin - MINI.bar - h, w, h };
}

/** Shrinks playback into a corner so you can keep browsing. */
export async function enterMini() {
  const store = useLibraryStore.getState();
  if (!store.playerSession || store.playerMini) return;
  if (enteredFullscreen || (await getCurrentWindow().isFullscreen())) {
    enteredFullscreen = false;
    await getCurrentWindow().setFullscreen(false);
    await new Promise((r) => setTimeout(r, 450)); // let the window settle before measuring
  }
  store.setPlayerMini(true);
  await invoke('player_layout', { rect: miniRect() }).catch((e) => console.warn('[player]', e));
}

export async function exitMini() {
  const store = useLibraryStore.getState();
  if (!store.playerMini) return;
  await invoke('player_layout', { rect: null }).catch((e) => console.warn('[player]', e));
  store.setPlayerMini(false);
}

/** Keeps the mini video aligned with its frame when the window resizes. */
export function syncMiniLayout() {
  if (useLibraryStore.getState().playerMini) void invoke('player_layout', { rect: miniRect() }).catch(() => {});
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
      countWatchTime(payload.media_type, payload.media_id, payload.time);
      if (Date.now() - lastSave > 15000) {
        lastSave = Date.now();
        void flushWatchTime();
      }
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
      await flushWatchTime();
      tick = null;
      await store.reload();
    }),

    listen<BuiltinPlayerState>('player-state', ({ payload }) => {
      const store = useLibraryStore.getState();
      if (!store.playerSession) return;
      store.setPlayerState(payload);
      if (payload.loaded && !payload.paused) countWatchTime(store.playerSession.target.type, store.playerSession.target.id, payload.time, payload.speed);
      // Persist the resume point every few seconds (and right away at the end).
      if (payload.loaded && payload.duration > 0 && (payload.eof || Date.now() - lastSave > 5000)) {
        lastSave = Date.now();
        void saveBuiltinProgress();
        void flushWatchTime();
      }
    }),
    listen<string>('player-tracks', ({ payload }) => {
      try {
        useLibraryStore.getState().setPlayerTracks(JSON.parse(payload) as PlayerTrack[]);
        syncAudioFilters();
      } catch {
        /* ignore malformed track lists */
      }
    }),
    listen<string>('player-chapters', ({ payload }) => {
      try {
        const list = JSON.parse(payload) as { title?: string; time: number }[];
        useLibraryStore.getState().setPlayerChapters(list.map((c) => ({ title: c.title ?? '', time: c.time })));
      } catch {
        /* ignore */
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
