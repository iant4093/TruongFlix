import { create } from 'zustand';
import { setMusicLibrary, useMusicPlayer } from './player';
import type { MusicPin, MusicPinKind, MusicPlaylist } from './types';

/** Library loading and playlist edits (applied locally right away, then saved). */

const api = () => {
  const a = useMusicPlayer.getState().api;
  if (!a) throw new Error('Music isn’t ready');
  return a;
};

let loading: Promise<void> | null = null;

export const useMusicLoad = create<{ error: string | null; loaded: boolean }>(() => ({ error: null, loaded: false }));

export function loadMusicLibrary(force = false): Promise<void> {
  if (loading && !force) return loading;
  if (!useMusicPlayer.getState().api || (!force && useMusicPlayer.getState().library)) return Promise.resolve();
  loading = api()
    .library()
    .then((lib) => {
      setMusicLibrary(lib);
      useMusicLoad.setState({ error: null, loaded: true });
    })
    .catch((e) => {
      useMusicLoad.setState({ error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function setPlaylists(update: (list: MusicPlaylist[]) => MusicPlaylist[]) {
  const lib = useMusicPlayer.getState().library;
  if (!lib) return;
  useMusicPlayer.setState({ library: { ...lib, playlists: update(lib.playlists) } });
}

const touch = (p: MusicPlaylist, patch: Partial<MusicPlaylist>): MusicPlaylist => ({ ...p, ...patch, updatedAt: Date.now() });

export async function createPlaylist(name: string, trackIds: number[] = []) {
  const created = await api().createPlaylist(name.trim() || 'New Playlist', trackIds);
  setPlaylists((list) => [created, ...list.filter((p) => p.id !== created.id)]);
  return created;
}

export async function renamePlaylist(id: number, name: string) {
  setPlaylists((list) => list.map((p) => (p.id === id ? touch(p, { name }) : p)));
  await api().renamePlaylist(id, name);
}

export async function deletePlaylist(id: number) {
  setPlaylists((list) => list.filter((p) => p.id !== id));
  setPins((pins) => pins.filter((p) => !(p.kind === 'playlist' && p.id === id)));
  await api().deletePlaylist(id);
}

export async function setPlaylistTracks(id: number, trackIds: number[]) {
  setPlaylists((list) => list.map((p) => (p.id === id ? touch(p, { trackIds }) : p)).sort((a, b) => b.updatedAt - a.updatedAt));
  await api().setPlaylistTracks(id, trackIds);
}

export async function addToPlaylist(id: number, trackIds: number[]) {
  setPlaylists((list) => list.map((p) => (p.id === id ? touch(p, { trackIds: [...p.trackIds, ...trackIds] }) : p)).sort((a, b) => b.updatedAt - a.updatedAt));
  await api().addToPlaylist(id, trackIds);
}

function setPins(update: (pins: MusicPin[]) => MusicPin[]) {
  const lib = useMusicPlayer.getState().library;
  if (!lib) return;
  useMusicPlayer.setState({ library: { ...lib, pins: update(lib.pins ?? []) } });
}

/** Pins (added at the end of the Pinned row) or unpins an album or playlist; undone if saving fails. */
export async function setPinned(kind: MusicPinKind, id: number, value: boolean) {
  const before = useMusicPlayer.getState().library?.pins ?? [];
  const others = (pins: MusicPin[]) => pins.filter((p) => !(p.kind === kind && p.id === id));
  setPins((pins) => (value ? (pins.some((p) => p.kind === kind && p.id === id) ? pins : [...pins, { kind, id }]) : others(pins)));
  try {
    await api().setPinned(kind, id, value);
  } catch (e) {
    const had = before.some((p) => p.kind === kind && p.id === id);
    setPins((pins) => (had ? (pins.some((p) => p.kind === kind && p.id === id) ? pins : before) : others(pins)));
    throw e;
  }
}

export function moveInList<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
