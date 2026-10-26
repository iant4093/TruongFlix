import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import { runScan } from './scanner';

let unlisten: UnlistenFn | null = null;

/** (Re)starts watching the media folders; changes trigger a quiet incremental scan. */
export async function startFolderWatch() {
  const { settings } = useLibraryStore.getState();
  const paths = settings.watch_folders && settings.tmdb_api_key ? settings.media_directories : [];
  unlisten ??= await listen<string[]>('library-changed', () => void runScan({ quiet: true }));
  await invoke('watch_folders', { paths }).catch((e) => console.warn('[watch]', e));
}
