import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLibraryStore } from '../store/useLibraryStore';
import type { PlayerTrack, PlayTarget, Profile } from '../types/media';
import type { RemoteAudioTrack, RemoteCommandAction, RemoteNowPlaying, RemoteSubTrack } from '../remote/types';
import { castControl, castSeek, stopCasting } from './cast';
import {
  closeBuiltin,
  dismissPrompt,
  exitMini,
  noteUserActivity,
  play,
  playBuiltin,
  playerCommand,
  playerSet,
  seekLive,
  toggleFullscreen,
} from './player';
import { languageName } from './subtitles';

/**
 * "Playing on <PC>": lets a signed-in browser (phone) see and control what the desktop app's
 * player or cast session is playing, and start playback on the PC.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The signed-in browser a request came from (identified by the media server). */
export interface Caller {
  session: string;
  device: string;
  /** This computer's name, as reported by the media server. */
  pc?: string;
}

export const OTHER_PROFILE = 'Playing on another profile';

const pcName = (caller: Caller) => caller.pc || 'your computer';

const hits = new Map<string, number[]>();

/** Sliding-window limit per browser and kind of request. */
export function rateLimit(caller: Caller, kind: string, max: number, windowMs: number) {
  const k = `${kind}:${caller.session}`;
  const now = Date.now();
  const list = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new ApiError(429, 'Too many requests. Slow down a little.');
  list.push(now);
  hits.set(k, list);
}

/** The browser's (unlocked) profile must be the one open on the PC, unless that one has no PIN. */
function authorize(profile: Profile) {
  const pc = useLibraryStore.getState().activeProfile;
  if (!pc || (pc.id !== profile.id && pc.pin)) throw new ApiError(403, OTHER_PROFILE);
}

const announced = new Set<string>();

/** Desktop toast the first time a browser takes control in this app session. */
export function noteController(caller: Caller) {
  if (announced.has(caller.session)) return;
  announced.add(caller.session);
  useLibraryStore.getState().toast(`${caller.device} is controlling playback`, 'info');
}

function lang(t: PlayerTrack) {
  return t.lang && t.lang !== 'und' ? languageName(t.lang) : null;
}

const CHANNELS: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 7: '6.1', 8: '7.1' };

function audioTracks(tracks: PlayerTrack[]): RemoteAudioTrack[] {
  return tracks
    .filter((t) => t.type === 'audio')
    .map((t) => ({
      id: t.id,
      label: lang(t) ?? t.title ?? `Track ${t.id}`,
      detail: [t.title && lang(t) ? t.title : '', CHANNELS[t['demux-channel-count'] ?? t['audio-channels'] ?? 0] ?? ''].filter(Boolean).join(' · ') || null,
      selected: !!t.selected,
    }));
}

function subTracks(tracks: PlayerTrack[]): RemoteSubTrack[] {
  return tracks
    .filter((t) => t.type === 'sub')
    .map((t) => ({
      id: t.id,
      label: lang(t) ?? t.title ?? `Subtitles ${t.id}`,
      detail: [t.forced ? 'Forced' : '', t['hearing-impaired'] ? 'SDH' : '', t.external ? 'Downloaded' : t.title && lang(t) ? t.title : ''].filter(Boolean).join(' · ') || null,
      selected: !!t.selected,
    }));
}

async function isFullscreen() {
  try {
    return await getCurrentWindow().isFullscreen();
  } catch {
    return false;
  }
}

function artFor(itemKey: string | null) {
  const item = itemKey ? useLibraryStore.getState().items.find((i) => i.key === itemKey) : undefined;
  return { art: item?.backdrop ?? item?.poster ?? null, poster: item?.poster ?? null };
}

/** GET /remote/state */
export async function nowPlaying(caller: Caller, profile: Profile): Promise<RemoteNowPlaying> {
  const { playerSession: session, playerState: state, playerTracks, playerPrompt, cast } = useLibraryStore.getState();
  const pc = pcName(caller);
  if (!session && !cast) return { active: false, pc };
  authorize(profile);
  if (session) {
    const live = session.target.type === 'live';
    const multiview = 'multiview' in session && !!session.multiview;
    const { art, poster } = artFor(session.itemKey);
    return {
      active: true,
      pc,
      source: live ? 'live' : 'player',
      type: session.target.type,
      id: session.target.id,
      itemKey: session.itemKey,
      title: session.title,
      subtitle: session.subtitle,
      art,
      poster,
      logo: session.logo,
      time: state?.time ?? 0,
      duration: live ? 0 : (state?.duration ?? 0),
      paused: state?.paused ?? false,
      buffering: !state?.loaded || !!state?.buffering,
      volume: state ? Math.round(state.volume) : null,
      muted: !!state?.muted,
      fullscreen: await isFullscreen(),
      audioTracks: live ? [] : audioTracks(playerTracks),
      subTracks: live ? [] : subTracks(playerTracks),
      next: 'nextLabel' in session ? session.nextLabel : null,
      prompt: playerPrompt,
      can: {
        seek: !live,
        skip: !multiview,
        volume: true,
        tracks: !live,
        next: !live && !!('next' in session && session.next),
        fullscreen: true,
      },
    };
  }
  const c = cast!;
  return {
    active: true,
    pc,
    source: 'cast',
    castDevice: c.device.name,
    type: c.target.type,
    id: c.target.id,
    title: c.title,
    subtitle: c.subtitle,
    art: c.image,
    poster: c.image,
    time: c.offset + c.time,
    duration: c.duration,
    paused: c.state === 'paused' || c.state === 'idle' || c.state === 'ended',
    buffering: c.state === 'connecting' || c.state === 'buffering',
    volume: null,
    muted: false,
    fullscreen: false,
    audioTracks: [],
    subTracks: [],
    next: null,
    prompt: null,
    can: { seek: true, skip: true, volume: false, tracks: false, next: false, fullscreen: false },
  };
}

function num(value: unknown) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) throw new ApiError(400, 'Invalid value');
  return n;
}

/** POST /remote/command — reuses the same player actions as the desktop controls. */
export async function command(caller: Caller, profile: Profile, action: RemoteCommandAction, value: unknown) {
  rateLimit(caller, 'command', 40, 10_000);
  const store = useLibraryStore.getState();
  const { playerSession: session, playerState: state, playerTracks, playerPrompt, cast } = store;
  if (!session && !cast) throw new ApiError(404, `Nothing is playing on ${pcName(caller)}`);
  authorize(profile);
  noteController(caller);
  noteUserActivity();

  if (!session && cast) {
    const at = cast.offset + cast.time;
    if (action === 'toggle') castControl(cast.state === 'playing' ? 'pause' : 'play');
    else if (action === 'play' || action === 'pause') castControl(action);
    else if (action === 'seek') await castSeek(Math.max(0, num(value)));
    else if (action === 'skip') await castSeek(Math.max(0, at + Math.max(-600, Math.min(600, num(value)))));
    else if (action === 'stop') await stopCasting();
    else throw new ApiError(400, 'Not available while casting');
    return { ok: true };
  }

  const s = session!;
  const live = s.target.type === 'live';
  const resume = () => {
    if (playerPrompt === 'limit' || playerPrompt === 'bedtime') throw new ApiError(403, 'Playback is paused by this profile’s viewing limits.');
    dismissPrompt();
  };
  switch (action) {
    case 'toggle':
      if (playerPrompt) resume();
      else await playerCommand('cycle', 'pause');
      break;
    case 'play':
      if (playerPrompt) resume();
      else await playerSet('pause', 'no');
      break;
    case 'pause':
      await playerSet('pause', 'yes');
      break;
    case 'seek': {
      if (live) throw new ApiError(400, 'Live TV can’t be scrubbed');
      const max = state?.duration ? state.duration - 1 : Infinity;
      await playerCommand('seek', Math.max(0, Math.min(max, num(value))).toFixed(2), 'absolute');
      break;
    }
    case 'skip': {
      const delta = Math.max(-600, Math.min(600, num(value)));
      if (live) await seekLive(delta);
      else await playerCommand('seek', delta, 'relative');
      break;
    }
    case 'volume': {
      const v = Math.round(Math.max(0, Math.min(100, num(value))));
      await playerSet('volume', v);
      if (state?.muted && v > 0) await playerSet('mute', 'no');
      break;
    }
    case 'mute':
      await playerSet('mute', (value == null ? !state?.muted : !!value) ? 'yes' : 'no');
      break;
    case 'audio': {
      const id = num(value);
      if (live || !playerTracks.some((t) => t.type === 'audio' && t.id === id)) throw new ApiError(400, 'Unknown audio track');
      await playerSet('aid', id);
      break;
    }
    case 'subtitle': {
      const id = num(value);
      if (live || (id > 0 && !playerTracks.some((t) => t.type === 'sub' && t.id === id))) throw new ApiError(400, 'Unknown subtitle track');
      await playerSet('sid', id > 0 ? id : 'no');
      break;
    }
    case 'next':
      if (live || !('next' in s) || !s.next) throw new ApiError(400, 'There’s no next episode');
      void playBuiltin(s.next);
      break;
    case 'stop':
      await closeBuiltin();
      break;
    case 'fullscreen':
      if (store.playerMini) await exitMini();
      await toggleFullscreen();
      break;
    default:
      throw new ApiError(400, 'Unknown command');
  }
  return { ok: true };
}

/** Starts a title in the desktop app's player for a browser whose profile is the one open on the PC. */
export async function startOnPc(caller: Caller, profile: Profile, target: PlayTarget) {
  const store = useLibraryStore.getState();
  if (store.activeProfile?.id !== profile.id) {
    throw new ApiError(
      403,
      store.activeProfile
        ? `${pcName(caller)} is using ${store.activeProfile.name}’s profile. Switch to ${profile.name} on the PC to play there.`
        : `Pick ${profile.name}’s profile on ${pcName(caller)} first.`,
    );
  }
  if (store.playerPrompt === 'limit' || store.playerPrompt === 'bedtime') throw new ApiError(403, 'Playback is paused by this profile’s viewing limits.');
  noteController(caller);
  // play() checks limits, reachability and the engine itself and reports problems on the PC.
  await Promise.race([play(target), new Promise((r) => setTimeout(r, 8000))]);
  return { ok: true };
}
