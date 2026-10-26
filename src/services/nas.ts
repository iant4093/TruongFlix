import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { ShareInfo } from '../types/media';
import { rootFor } from './files';

/**
 * Records which media folders live on network shares (and the NAS's Wake-on-LAN address) while
 * they're connected, so they can be reconnected — and the NAS woken — when they're not.
 */
export async function refreshShares() {
  const { settings, updateSettings } = useLibraryStore.getState();
  const dirs = settings.media_directories;
  if (!dirs.length) return;
  const online = await invoke<boolean[]>('check_paths', { paths: dirs }).catch(() => dirs.map(() => false));
  const found = await invoke<(ShareInfo | null)[]>('share_info', { paths: dirs.filter((_, i) => online[i]) }).catch(() => []);
  const next: Record<string, ShareInfo> = {};
  const reachable = dirs.filter((_, i) => online[i]);
  for (const dir of dirs) {
    const old = settings.network_shares[dir];
    const idx = reachable.indexOf(dir);
    const now = idx >= 0 ? found[idx] : undefined;
    if (now) next[dir] = { ...now, mac: now.mac ?? old?.mac ?? null };
    else if (idx < 0 && old) next[dir] = old; // offline: keep what we knew
  }
  if (JSON.stringify(next) !== JSON.stringify(settings.network_shares)) await updateSettings({ network_shares: next });
}

/** Tries to bring offline network folders back (no Wake-on-LAN). Returns the folders reconnected. */
export async function reconnectOfflineShares(): Promise<string[]> {
  const { settings } = useLibraryStore.getState();
  const dirs = settings.media_directories.filter((d) => settings.network_shares[d]);
  if (!dirs.length) return [];
  const online = await invoke<boolean[]>('check_paths', { paths: dirs }).catch(() => dirs.map(() => true));
  const back: string[] = [];
  for (const [i, dir] of dirs.entries()) {
    if (online[i]) continue;
    const ok = await invoke('connect_share', { share: settings.network_shares[dir], wake: false }).then(
      () => true,
      () => false,
    );
    if (ok) back.push(dir);
  }
  return back;
}

/** Wakes the NAS (if needed) and reconnects the share behind `dir`. Returns true when reachable. */
export async function connectShare(dir: string, opts: { wake: boolean; quiet?: boolean }): Promise<boolean> {
  const { settings, toast } = useLibraryStore.getState();
  const share = settings.network_shares[dir];
  if (!share) return false;
  const off = opts.quiet
    ? () => {}
    : await listen<{ host: string; stage: string }>('nas-progress', ({ payload }) => {
        if (payload.stage === 'waking') toast(`Waking up ${payload.host}… this can take a minute`, 'info');
        else if (payload.stage === 'connecting') toast(`Connecting to ${payload.host}…`, 'info');
      });
  try {
    await invoke('connect_share', { share, wake: opts.wake });
    return true;
  } catch (e) {
    if (!opts.quiet) toast(String(e), 'error');
    return false;
  } finally {
    off();
  }
}

/** Before playback: makes sure the file's network folder is mounted, waking the NAS if asleep. */
export async function ensureReachable(filePath: string): Promise<boolean> {
  const { settings } = useLibraryStore.getState();
  const root = rootFor(filePath, settings.media_directories);
  if (!root || !settings.network_shares[root]) return true;
  const [online] = await invoke<boolean[]>('check_paths', { paths: [root] }).catch(() => [true]);
  if (online) return true;
  return connectShare(root, { wake: true });
}

export const hasNetworkFolders = () => {
  const { settings } = useLibraryStore.getState();
  return settings.media_directories.some((d) => settings.network_shares[d]);
};
