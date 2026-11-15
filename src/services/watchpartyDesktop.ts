import { create } from 'zustand';
import { useLibraryStore } from '../store/useLibraryStore';
import { episodeTarget } from '../store/selectors';
import type { BuiltinPlayerState, PlayTarget } from '../types/media';
import type { TogetherRoomSummary, TogetherState, TogetherTitle } from '../remote/together';
import { TogetherClient, type TogetherPlayer } from '../remote/togetherClient';
import { parties, type MemberInfo } from './watchparty';
import { playBuiltin, playerCommand, playerSet } from './player';

/**
 * The desktop's built-in player as a watch-party participant. It talks to the rooms in-process
 * (the rooms live in this app) and follows them like any browser does.
 */

export const DESKTOP_MEMBER = 'desktop';

interface DesktopParty {
  state: TogetherState | null;
  rooms: TogetherRoomSummary[] | null;
  busy: boolean;
  error: string;
}

export const useDesktopParty = create<DesktopParty>(() => ({ state: null, rooms: null, busy: false, error: '' }));

function member(): MemberInfo {
  const profile = useLibraryStore.getState().activeProfile;
  if (!profile) throw new Error('Pick a profile first');
  return { id: DESKTOP_MEMBER, name: profile.name, device: 'PC app', kind: 'desktop', profile: { id: profile.id, maturity: profile.maturity } };
}

function currentTitle(): TogetherTitle | null {
  const t = useLibraryStore.getState().playerSession?.target;
  return t && (t.type === 'movie' || t.type === 'episode') ? { type: t.type, id: t.id } : null;
}

/** Last player state and when it arrived, to estimate the position between state events. */
let lastState: { state: BuiltinPlayerState; at: number } | null = null;

function position() {
  if (!lastState) return useLibraryStore.getState().playerState?.time ?? 0;
  const { state, at } = lastState;
  return state.paused || !state.loaded || state.buffering ? state.time : state.time + ((Date.now() - at) / 1000) * (state.speed || 1);
}

/** A movie or episode from the library as something the built-in player can open. */
export function targetFor(title: TogetherTitle, start: number): PlayTarget | null {
  const { movies, episodes, series } = useLibraryStore.getState();
  if (title.type === 'movie') {
    const m = movies.find((x) => x.id === title.id);
    return m ? { type: 'movie', id: m.id, filePath: m.file_path, startTime: start, label: m.title } : null;
  }
  const e = episodes.find((x) => x.id === title.id);
  if (!e) return null;
  return { ...episodeTarget(e, series.find((s) => s.id === e.series_id) ?? { title: e.title }), startTime: start };
}

const player: TogetherPlayer = {
  title: currentTitle,
  position,
  playing: () => !!lastState && !lastState.state.paused,
  buffering: () => {
    const s = useLibraryStore.getState().playerState;
    return !s?.loaded || s.buffering || s.seeking;
  },
  rate: () => useLibraryStore.getState().playerState?.speed ?? 1,
  play: () => void playerSet('pause', 'no'),
  pause: () => void playerSet('pause', 'yes'),
  seek: (t) => void playerCommand('seek', t.toFixed(2), 'absolute'),
  setRate: (r) => void playerSet('speed', Number(r.toFixed(3))),
  switchTitle: (title, start) => {
    const target = targetFor(title, Math.max(0, start));
    if (!target) {
      useLibraryStore.getState().toast('This watch party is playing something that isn’t in your library', 'error');
      void leaveParty();
      return;
    }
    void playBuiltin(target);
  },
};

const client = new TogetherClient(
  {
    poll: async (code, report) => parties.poll(DESKTOP_MEMBER, code, report),
    act: (code, action, value, since) => parties.act(DESKTOP_MEMBER, code, action, value, since),
    leave: async () => parties.leave(DESKTOP_MEMBER),
  },
  player,
  {
    onState: (state) => useDesktopParty.setState({ state }),
    onEvent: (e) => useLibraryStore.getState().toast(e.text, 'info'),
    onEnded: (reason) => {
      unwatch();
      if (reason) useLibraryStore.getState().toast(reason, 'info');
    },
  },
);

let unsubscribe: (() => void) | null = null;

/** Turns the player's own changes into party events while in a party. */
function watch() {
  if (unsubscribe) return;
  const s = useLibraryStore.getState().playerState;
  lastState = s ? { state: s, at: Date.now() } : null;
  unsubscribe = useLibraryStore.subscribe((state, prev) => {
    if (!state.playerSession) {
      void leaveParty();
      return;
    }
    const title = currentTitle();
    if (state.playerSession !== prev.playerSession) {
      client.settle();
      const before = prev.playerSession?.target;
      if (title && (!before || before.type !== title.type || before.id !== title.id)) client.localTitle(title);
    }
    const now = state.playerState;
    if (now === prev.playerState) return;
    const was = lastState;
    lastState = now ? { state: now, at: Date.now() } : null;
    if (!now || !now.loaded) return client.settle();
    if (!was || !was.state.loaded || was.state.load_id !== now.load_id) return client.settle();
    if (now.paused !== was.state.paused) client.localPlaying(!now.paused);
    if (Math.abs(now.speed - was.state.speed) > 0.001) client.localRate(now.speed);
    const expected = was.state.paused ? was.state.time : was.state.time + ((Date.now() - was.at) / 1000) * (was.state.speed || 1);
    if (Math.abs(now.time - expected) > 2) client.localSeek();
  });
}

function unwatch() {
  unsubscribe?.();
  unsubscribe = null;
}

async function begin(fn: () => Promise<TogetherState>) {
  useDesktopParty.setState({ busy: true, error: '' });
  try {
    const state = await fn();
    watch();
    client.start(state);
  } catch (e) {
    useDesktopParty.setState({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    useDesktopParty.setState({ busy: false });
  }
}

/** Starts a party for what the built-in player is playing. */
export function createParty() {
  return begin(() => {
    const title = currentTitle();
    if (!title) throw new Error('Play a movie or episode first');
    const s = useLibraryStore.getState().playerState;
    return parties.create(member(), title, { position: position(), playing: !!s && !s.paused, rate: s?.speed ?? 1 });
  });
}

export function joinParty(code: string) {
  return begin(() => parties.join(code, member()));
}

export async function leaveParty() {
  unwatch();
  await client.leave();
}

export function setPartyWait(on: boolean) {
  client.setWaitForAll(on);
}

export async function refreshParties() {
  useDesktopParty.setState({ rooms: null });
  try {
    const p = member();
    useDesktopParty.setState({ rooms: await parties.list(p.profile) });
  } catch (e) {
    useDesktopParty.setState({ rooms: [], error: e instanceof Error ? e.message : String(e) });
  }
}
