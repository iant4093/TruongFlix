import { invoke } from '@tauri-apps/api/core';
import manifest from './backupManifest.json';

/** A folder the backup's settings point to. */
export type BackupPath = { path: string; key: string; exists: boolean; share: boolean };
export type BackupInfo = { token: string; version: number; secrets: boolean; paths: BackupPath[]; profiles: number; titles: number };
/** After a restart that restored a backup. */
export type Restored = { local: Record<string, string>; missing: string[] };

/** What each folder setting is called on screen. */
export const FOLDER_LABELS: Record<string, string> = {
  media_directories: 'Movies & TV folder',
  music_directories: 'Music folder',
  torrent_movies_dir: 'Torrent movies folder',
  torrent_tv_dir: 'Torrent TV folder',
  music_download_dir: 'Music downloads folder',
  games_download_dir: 'Game downloads folder',
  games_install_dir: 'Games folder',
};

/** The preferences kept in the window's storage that travel with a backup. */
export function carriedPrefs(storage: Pick<Storage, 'getItem'> = localStorage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of manifest.localStorage.carry) {
    const value = storage.getItem(key);
    if (value != null) out[key] = value;
  }
  return out;
}

export function exportBackup(path: string, includeSecrets: boolean) {
  return invoke('backup_export', { path, includeSecrets, local: carriedPrefs() });
}

let finished: Promise<Restored | null> | null = null;

/**
 * Finishes a restore applied at startup: puts the backup's preferences back into the window's
 * storage. Runs before the app's modules load (they read that storage when loaded); later calls
 * give the same result.
 */
export function finishRestore(storage: Pick<Storage, 'setItem'> = localStorage): Promise<Restored | null> {
  finished ??= invoke<Restored | null>('backup_restore_result').then((restored) => {
    if (!restored || typeof restored !== 'object') return null;
    for (const key of manifest.localStorage.carry) {
      const value = restored.local?.[key];
      if (typeof value !== 'string') continue;
      try {
        storage.setItem(key, value);
      } catch {
        // Storage full: that preference starts fresh.
      }
    }
    return { local: restored.local ?? {}, missing: Array.isArray(restored.missing) ? restored.missing : [] };
  });
  return finished;
}

/** The toast after a restore. */
export function restoredMessage(restored: Restored): string {
  const n = restored.missing.length;
  if (!n) return 'TruongFlix backup restored';
  return `Backup restored. ${n === 1 ? '1 folder isn’t' : `${n} folders aren’t`} on this computer: set ${n === 1 ? 'it' : 'them'} again in Settings.`;
}
