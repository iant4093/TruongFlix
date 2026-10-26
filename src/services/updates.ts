import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { useLibraryStore } from '../store/useLibraryStore';
import { closeBuiltin } from './player';

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
}

let pending: Update | null = null;
const listeners = new Set<(u: AvailableUpdate | null) => void>();

const summarize = (u: Update): AvailableUpdate => ({
  version: u.version,
  currentVersion: u.currentVersion,
  date: u.date ?? null,
  notes: u.body ?? null,
});

export const appVersion = () => getVersion();

export function availableUpdate(): AvailableUpdate | null {
  return pending ? summarize(pending) : null;
}

export function onUpdateChange(fn: (u: AvailableUpdate | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Asks the release feed for a newer, signed build. Returns null when up to date. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  pending = await check();
  await useLibraryStore.getState().updateSettings({ updates_last_check: new Date().toISOString() });
  const info = availableUpdate();
  listeners.forEach((fn) => fn(info));
  return info;
}

/**
 * Downloads, verifies (against the public key built into the app) and installs the update,
 * then restarts. The bundled player engine is updated along with the app.
 */
export async function installUpdate(onProgress: (downloaded: number, total: number | null) => void) {
  if (!pending) throw new Error('No update available');
  await closeBuiltin();
  let downloaded = 0;
  let total: number | null = null;
  await pending.downloadAndInstall((event) => {
    if (event.event === 'Started') total = event.data.contentLength ?? null;
    else if (event.event === 'Progress') downloaded += event.data.chunkLength;
    onProgress(downloaded, total);
  });
  await relaunch();
}

/** Startup check (at most once a day) that surfaces a toast when a new version exists. */
export async function autoCheckForUpdates() {
  const { settings, toast } = useLibraryStore.getState();
  if (!settings.updates_auto_check || import.meta.env.DEV) return;
  const last = Date.parse(settings.updates_last_check || '');
  if (last && Date.now() - last < 24 * 3600 * 1000) return;
  try {
    const u = await checkForUpdate();
    if (u) toast(`TruongFlix ${u.version} is available — install it from Settings › About & Updates`, 'info');
  } catch (e) {
    console.warn('[updates] check failed', e);
  }
}
