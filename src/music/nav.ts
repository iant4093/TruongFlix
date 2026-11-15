import { create } from 'zustand';

export type MusicTab = 'listen' | 'albums' | 'artists' | 'songs' | 'playlists' | 'favourites';

export type MusicRoute =
  | { page: MusicTab }
  | { page: 'album'; id: number }
  | { page: 'artist'; id: number }
  | { page: 'playlist'; id: number };

export const MUSIC_TABS: { tab: MusicTab; label: string }[] = [
  { tab: 'listen', label: 'Listen Now' },
  { tab: 'albums', label: 'Albums' },
  { tab: 'artists', label: 'Artists' },
  { tab: 'songs', label: 'Songs' },
  { tab: 'playlists', label: 'Playlists' },
  { tab: 'favourites', label: 'Favourites' },
];

interface MusicNav {
  stack: MusicRoute[];
  query: string;
  toast: { id: number; text: string } | null;
}

export const useMusicNav = create<MusicNav>(() => ({ stack: [{ page: 'listen' }], query: '', toast: null }));

export const currentRoute = (s: MusicNav) => s.stack[s.stack.length - 1];

export function openTab(tab: MusicTab) {
  useMusicNav.setState({ stack: [{ page: tab }], query: '' });
}

export function openRoute(route: MusicRoute) {
  useMusicNav.setState((s) => ({ stack: [...s.stack, route], query: '' }));
}

export function goBack() {
  useMusicNav.setState((s) => ({ stack: s.stack.length > 1 ? s.stack.slice(0, -1) : s.stack }));
}

export function setMusicQuery(query: string) {
  useMusicNav.setState({ query });
}

let toastId = 0;
export function musicToast(text: string) {
  const id = ++toastId;
  useMusicNav.setState({ toast: { id, text } });
  setTimeout(() => {
    if (useMusicNav.getState().toast?.id === id) useMusicNav.setState({ toast: null });
  }, 2600);
}
