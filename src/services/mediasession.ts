import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import { closeBuiltin, noteUserActivity, playBuiltin, playerCommand, playerSet } from './player';
import { resize } from './tmdb';

interface SessionUpdate {
  title: string;
  artist: string | null;
  album: string | null;
  duration: number;
  position: number;
  state: 'playing' | 'paused';
  rate: number;
  cover_url: string | null;
  can_next: boolean;
}

let last: (SessionUpdate & { sentAt: number }) | null = null;
let active = false;

/** What the system media controls should show for the current playback, or null. */
function describeNowPlaying(): SessionUpdate | null {
  const { playerSession: session, playerState: state, allItems, episodes } = useLibraryStore.getState();
  if (!session || !state?.loaded) return null;
  const item = allItems.find((i) => i.key === session.itemKey);
  const ep = session.target.type === 'episode' ? episodes.find((e) => e.id === session.target.id) : undefined;
  const cover = resize(ep?.still_path ?? item?.backdrop ?? item?.poster ?? null, 'w780');
  return {
    title: ep ? ep.title : session.title,
    artist: ep ? session.title : item?.year ? String(item.year) : 'TruongFlix',
    album: ep ? `Season ${ep.season_number} · Episode ${ep.episode_number}` : null,
    duration: state.duration,
    position: state.time,
    state: state.paused || state.eof ? 'paused' : 'playing',
    rate: state.speed || 1,
    cover_url: cover && /^https?:/.test(cover) ? cover : null,
    can_next: !!session.next,
  };
}

/** Only pushes when something the system can't extrapolate changes (track, pause, speed, seek). */
function sync() {
  const next = describeNowPlaying();
  if (!next) {
    if (active) {
      active = false;
      last = null;
      void invoke('media_session_clear').catch(() => {});
    }
    return;
  }
  const now = Date.now();
  if (last) {
    const expected = last.state === 'playing' ? last.position + ((now - last.sentAt) / 1000) * last.rate : last.position;
    const same =
      last.title === next.title &&
      last.artist === next.artist &&
      last.state === next.state &&
      last.rate === next.rate &&
      last.can_next === next.can_next &&
      last.cover_url === next.cover_url &&
      Math.abs(last.duration - next.duration) < 1 &&
      Math.abs(expected - next.position) < 2 &&
      now - last.sentAt < 30_000;
    if (same) return;
  }
  last = { ...next, sentAt: now };
  active = true;
  void invoke('media_session_update', { update: next }).catch((e) => console.warn('[media session]', e));
}

async function handle(action: string, value: number) {
  const store = useLibraryStore.getState();
  const { playerSession: session, playerState: state } = store;
  if (!session) return;
  noteUserActivity();
  switch (action) {
    case 'play':
      if (store.playerPrompt) return; // the prompt needs an answer first
      await playerSet('pause', 'no');
      break;
    case 'pause':
      await playerSet('pause', 'yes');
      break;
    case 'toggle':
      if (store.playerPrompt) return;
      await playerCommand('cycle', 'pause');
      break;
    case 'next':
      if (session.next) await playBuiltin(session.next);
      break;
    case 'previous':
      await playerCommand('seek', 0, 'absolute');
      break;
    case 'seek_by':
      await playerCommand('seek', value, 'relative');
      break;
    case 'set_position':
      if (state?.duration) await playerCommand('seek', Math.max(0, Math.min(value, state.duration - 1)).toFixed(2), 'absolute');
      break;
    case 'stop':
      await closeBuiltin();
      break;
  }
}

let started = false;

/** Media keys, headphone buttons, macOS Now Playing and the Windows media overlay. */
export async function initMediaSession() {
  if (started) return;
  started = true;
  await listen<{ action: string; value: number }>('media-control', ({ payload }) => void handle(payload.action, payload.value));
  useLibraryStore.subscribe((s, prev) => {
    if (s.playerSession !== prev.playerSession || s.playerState !== prev.playerState) sync();
  });
}
