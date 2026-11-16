import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import { runScan } from './scanner';
import { hasNetworkFolders } from './nas';

let unlisten: UnlistenFn | null = null;
let poll: number | null = null;
/** Network shares don't report changes made by other computers, so they're re-checked periodically. */
const NETWORK_RESCAN_MS = 15 * 60 * 1000;

/** (Re)starts watching the media and music folders; changes trigger a quiet incremental scan. */
export async function startFolderWatch() {
  const { settings } = useLibraryStore.getState();
  // Movies & TV need a TMDB key to match new files; music doesn't.
  const videoDirs = settings.watch_folders && settings.tmdb_api_key ? settings.media_directories : [];
  const musicDirs = settings.watch_folders ? settings.music_directories ?? [] : [];
  const paths = [...new Set([...videoDirs, ...musicDirs])];
  const enabled = paths.length > 0;
  unlisten ??= await listen<string[]>('library-changed', () => void runScan({ quiet: true }));
  await invoke('watch_folders', { paths }).catch((e) => console.warn('[watch]', e));
  if (poll != null) window.clearInterval(poll);
  poll = enabled && hasNetworkFolders() ? window.setInterval(() => void runScan({ quiet: true }), NETWORK_RESCAN_MS) : null;
}
