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

/** Scroll position of each page under the current one, so Back lands where you were. */
const scrolls: number[] = [];
let restore: number | null = null;
const scrollY = () => (typeof window === 'undefined' ? 0 : window.scrollY);

export function openTab(tab: MusicTab) {
  scrolls.length = 0;
  restore = null;
  useMusicNav.setState({ stack: [{ page: tab }], query: '' });
}

export function openRoute(route: MusicRoute) {
  scrolls.push(scrollY());
  restore = null;
  useMusicNav.setState((s) => ({ stack: [...s.stack, route], query: '' }));
}

export function goBack() {
  if (useMusicNav.getState().stack.length <= 1) return;
  restore = scrolls.pop() ?? 0;
  useMusicNav.setState((s) => ({ stack: s.stack.slice(0, -1) }));
}

/** Where to scroll after a page change: the remembered spot after Back, else the top. */
export function takeScroll(): number {
  const y = restore ?? 0;
  restore = null;
  return y;
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
