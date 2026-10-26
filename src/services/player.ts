import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLibraryStore } from '../store/useLibraryStore';
import { episodeTarget, playTargetFor } from '../store/selectors';
import type {
  AudioDevice,
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
import { ensureReachable } from './nas';
import { blockedMessage, formatLeft, limitStatus } from './limits';
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
  noteUserActivity(); // a title picked by hand starts a fresh "still watching" count
  const limit = await limitStatus(useLibraryStore.getState().activeProfile, pendingSeconds);
  if (limit.blocked) {
    const store = useLibraryStore.getState();
    store.toast(blockedMessage(store.activeProfile!, limit.blocked), 'error');
    return;
  }
  if (!(await ensureReachable(target.filePath))) return;
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
// Audio output: device, receiver passthrough, per-device delay
// ---------------------------------------------------------------------------

/** Codecs sent untouched to an AV receiver (Dolby Digital/Plus, DTS/DTS-HD, TrueHD incl. Atmos). */
const PASSTHROUGH_CODECS = 'ac3,eac3,dts,dts-hd,truehd';
let deviceCache: AudioDevice[] | null = null;

export async function listAudioDevices(refresh = false): Promise<AudioDevice[]> {
  if (!deviceCache || refresh) deviceCache = await invoke<AudioDevice[]>('audio_devices').catch(() => deviceCache ?? []);
  return deviceCache;
}

/** The output actually in use: the chosen device, or the system default when set to "auto". */
async function resolveOutput(): Promise<{ key: string; label: string }> {
  const { settings } = useLibraryStore.getState();
  const devices = await listAudioDevices();
  if (settings.audio_device && settings.audio_device !== 'auto') {
    return { key: settings.audio_device, label: devices.find((d) => d.name === settings.audio_device)?.description ?? settings.audio_device };
  }
  const def = await invoke<AudioDevice | null>('default_audio_device').catch(() => null);
  if (!def) return { key: 'auto', label: 'System default' };
  return { key: def.name, label: def.description || devices.find((d) => d.name === def.name)?.description || 'System default' };
}

export function passthroughOptions(on: boolean): [string, string][] {
  // CoreAudio only bitstreams in exclusive mode (other apps' sounds are muted meanwhile).
  return [['audio-spdif', on ? PASSTHROUGH_CODECS : ''], ...(IS_MAC ? ([['audio-exclusive', on ? 'yes' : 'no']] as [string, string][]) : [])];
}

let outputPoll: number | null = null;

/** Applies the remembered delay for whatever device is playing; re-checks when headphones connect. */
async function syncOutput(force = false) {
  const store = useLibraryStore.getState();
  if (!store.playerSession) return;
  const out = await resolveOutput();
  if (!force && store.audioOutput?.key === out.key) return;
  store.setAudioOutput(out);
  await playerSet('audio-delay', (store.settings.audio_delays[out.key] ?? 0).toFixed(2)).catch(() => {});
}

function startOutputWatch() {
  if (outputPoll != null) window.clearInterval(outputPoll);
  outputPoll = window.setInterval(() => void syncOutput(), 4000);
}

function stopOutputWatch() {
  if (outputPoll != null) window.clearInterval(outputPoll);
  outputPoll = null;
  useLibraryStore.getState().setAudioOutput(null);
}

/** Switches speakers ("auto" = follow the system), live if something is playing. */
export async function setAudioDevice(name: string) {
  const store = useLibraryStore.getState();
  await store.updateSettings({ audio_device: name });
  if (store.playerSession) {
    await playerSet('audio-device', name).catch(() => {});
    await syncOutput(true);
  }
}

export async function setPassthrough(on: boolean) {
  const store = useLibraryStore.getState();
  await store.updateSettings({ audio_passthrough: on });
  if (store.playerSession) for (const [k, v] of passthroughOptions(on)) await playerSet(k, v).catch(() => {});
}

/** Sets the audio delay and remembers it for the current output (e.g. AirPods lag). */
export async function setAudioDelay(seconds: number) {
  const store = useLibraryStore.getState();
  const value = Math.round(seconds * 10) / 10;
  await playerSet('audio-delay', value.toFixed(1)).catch(() => {});
  const key = store.audioOutput?.key ?? (await resolveOutput()).key;
  await store.updateSettings({ audio_delays: { ...store.settings.audio_delays, [key]: value } });
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
    const item = items.find((i) => i.kind === 'movie' && (i.id === target.id || i.versions.some((v) => v.id === target.id))) ?? null;
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
  store.setPlayerPrompt(null);
  try {
    const { settings } = useLibraryStore.getState();
    appliedAf = audioFilterChain(settings, mediaInfoFor(target)?.audio.find((a) => a.default)?.channels ?? 2);
    await invoke('player_open', {
      filePath: target.filePath,
      startTime: Math.max(0, target.startTime),
      subtitlePath: await subtitleFor(target),
      audioLang: null,
      subLang: null,
      options: [
        ...subtitleOptions(settings.subtitle_style),
        ['af', appliedAf],
        ['audio-device', settings.audio_device || 'auto'],
        ...passthroughOptions(settings.audio_passthrough),
      ],
    });
    void syncOutput(true);
    startOutputWatch();
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
  autoStreak = 0;
  pendingNext = null;
  setSleepTimer(null);
  stopOutputWatch();
  store.setPlayerPrompt(null);
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
// "Are you still watching?" and the sleep timer
// ---------------------------------------------------------------------------

/** Episodes that started on their own since the last key press, click or media button. */
let autoStreak = 0;
let pendingNext: PlayTarget | null = null;

export function noteUserActivity() {
  autoStreak = 0;
}

/**
 * Called when an episode ends (or its credits countdown finishes) and the next one would start.
 * Honors "stop after this episode" and asks "Are you still watching?" after a run of episodes.
 */
export function autoAdvance(next: PlayTarget) {
  const store = useLibraryStore.getState();
  if (stopForSleep()) return;
  autoStreak += 1;
  const limit = store.settings.still_watching_after;
  if (limit > 0 && autoStreak >= limit) {
    pendingNext = next;
    void pauseForPrompt('still-watching');
    return;
  }
  void playBuiltin(next);
}

/** "Stop at the end of this episode/movie": called when its credits start (or it ends). */
export function stopForSleep() {
  const store = useLibraryStore.getState();
  if (store.sleepTimer?.mode !== 'episode') return false;
  store.setSleepTimer(null);
  void pauseForPrompt('sleep-ended');
  return true;
}

async function pauseForPrompt(prompt: 'still-watching' | 'sleep-ended' | 'limit' | 'bedtime') {
  const store = useLibraryStore.getState();
  if (store.playerState && !store.playerState.paused && !store.playerState.eof) await playerSet('pause', 'yes').catch(() => {});
  store.setPlayerPrompt(prompt);
}

/** "Continue Watching" / "Resume" on the prompt. */
export function dismissPrompt() {
  const store = useLibraryStore.getState();
  const prompt = store.playerPrompt;
  if (prompt === 'limit' || prompt === 'bedtime') return void closeBuiltin(); // no way past these
  store.setPlayerPrompt(null);
  noteUserActivity();
  if (prompt === 'still-watching' && pendingNext) {
    const next = pendingNext;
    pendingNext = null;
    void playBuiltin(next);
  } else if (store.playerState?.eof) {
    void closeBuiltin();
  } else {
    void playerSet('pause', 'no');
  }
}

let sleepTick: number | null = null;
let fading = false;
const SLEEP_FADE_S = 10;

/** Starts (or cancels, with null) the sleep timer. */
export function setSleepTimer(choice: number | 'episode' | null) {
  const store = useLibraryStore.getState();
  if (sleepTick != null) window.clearInterval(sleepTick);
  sleepTick = null;
  if (choice == null) return store.setSleepTimer(null);
  if (choice === 'episode') return store.setSleepTimer({ mode: 'episode' });
  store.setSleepTimer({ mode: 'minutes', minutes: choice, endsAt: Date.now() + choice * 60_000 });
  sleepTick = window.setInterval(() => {
    const { sleepTimer, playerSession } = useLibraryStore.getState();
    if (!playerSession || sleepTimer?.mode !== 'minutes') {
      if (sleepTick != null) window.clearInterval(sleepTick);
      sleepTick = null;
      return;
    }
    if (!fading && Date.now() >= sleepTimer.endsAt - SLEEP_FADE_S * 1000) void fadeOutAndPause();
  }, 1000);
}

/** Lowers the volume over a few seconds, pauses, then restores the volume for next time. */
async function fadeOutAndPause() {
  fading = true;
  const start = useLibraryStore.getState().playerState?.volume ?? 100;
  for (let i = 1; i <= SLEEP_FADE_S * 2; i++) {
    if (useLibraryStore.getState().sleepTimer?.mode !== 'minutes') {
      await playerSet('volume', start).catch(() => {}); // cancelled mid-fade
      fading = false;
      return;
    }
    await playerSet('volume', Math.round(start * (1 - i / (SLEEP_FADE_S * 2)))).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
  await playerSet('pause', 'yes').catch(() => {});
  await playerSet('volume', start).catch(() => {});
  fading = false;
  if (sleepTick != null) window.clearInterval(sleepTick);
  sleepTick = null;
  const store = useLibraryStore.getState();
  store.setSleepTimer(null);
  store.setPlayerPrompt('sleep-ended');
}

// ---------------------------------------------------------------------------
// Kids' limits (daily viewing time, bedtime)
// ---------------------------------------------------------------------------

let limitTick: number | null = null;
let warnedFor = '';
const LIMIT_CHECK_MS = 20_000;

/** While something plays on a profile with limits: warn at 5 minutes left, stop when time's up. */
function startLimitWatch() {
  if (limitTick != null) return;
  limitTick = window.setInterval(async () => {
    const store = useLibraryStore.getState();
    const profile = store.activeProfile;
    const playing = !!store.playerSession || store.playback.active;
    if (!playing || !profile || (!profile.daily_limit && !profile.bedtime) || store.playerPrompt === 'limit' || store.playerPrompt === 'bedtime') return;
    const st = await limitStatus(profile, pendingSeconds);
    if (st.blocked) {
      store.toast(blockedMessage(profile, st.blocked), 'info');
      if (store.playerSession) void pauseForPrompt(st.blocked);
      else void stopPlayback();
      return;
    }
    const today = new Date().toDateString();
    if (st.remaining != null && st.remaining <= 300 && warnedFor !== `${profile.id}-${today}`) {
      warnedFor = `${profile.id}-${today}`;
      store.toast(`${formatLeft(st.remaining)} of TV left today`, 'info');
    }
  }, LIMIT_CHECK_MS);
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
  startLimitWatch();
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
    // Screen locked, display asleep or the computer going to sleep (lid closed).
    listen<{ reason: 'lock' | 'display' | 'sleep' }>('system-pause', ({ payload }) => {
      const store = useLibraryStore.getState();
      if (!store.settings.pause_on_lock) return;
      const why = payload.reason === 'lock' ? 'the screen locked' : payload.reason === 'sleep' ? 'the computer went to sleep' : 'the display went to sleep';
      if (store.playerSession && store.playerState && !store.playerState.paused) {
        void playerSet('pause', 'yes');
        store.toast(`Paused because ${why}`, 'info');
      } else if (store.playback.active) {
        void invoke('pause_vlc');
      }
    }),
  ]);
}

export function disposePlayerEvents() {
  unlisteners.forEach((u) => u());
  unlisteners = [];
}
