import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import { epLabel } from '../store/selectors';
import type { EpisodeRow, FileMove, MediaItem, TrashRow, TrashSnapshot } from '../types/media';
import * as db from './db';

export const TRASH_RETENTION_DAYS = 30;

const UA = navigator.userAgent;
export const FILE_MANAGER_NAME = UA.includes('Mac') ? 'Finder' : UA.includes('Windows') ? 'File Explorer' : 'File Manager';

const VIDEO_RE = /\.(mkv|mp4|m4v|avi|mov|webm|ts)$/i;

/** The configured media folder a path lives in (longest match), or '' if none. */
export function rootFor(path: string, roots: string[]): string {
  let best = '';
  for (const r of roots) {
    const root = r.replace(/[\\/]+$/, '');
    if ((path.startsWith(root + '/') || path.startsWith(root + '\\')) && root.length > best.length) best = root;
  }
  return best;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function revealInFileManager(path: string) {
  return invoke('reveal_in_file_manager', { path });
}

// ---------------------------------------------------------------------------
// Organize loose files
// ---------------------------------------------------------------------------

/** Puts loose videos into their own folders and re-points the library at the new paths. */
export async function organizeLooseFiles(roots: string[]): Promise<{ moved: number; errors: string[] }> {
  const res = await invoke<{ moved: FileMove[]; errors: string[] }>('organize_loose_files', { roots });
  if (res.moved.length) await db.updateFilePaths(res.moved);
  return { moved: res.moved.filter((m) => VIDEO_RE.test(m.to)).length, errors: res.errors };
}

// ---------------------------------------------------------------------------
// Delete → Recently Deleted
// ---------------------------------------------------------------------------

export type DeleteTarget =
  | { kind: 'movie'; item: MediaItem; /** Only this copy (when there are several versions). */ versionId?: number }
  | { kind: 'tv'; item: MediaItem }
  | { kind: 'episode'; episode: EpisodeRow; series: MediaItem };

interface TrashResult {
  entry_dir: string;
  items: FileMove[];
  size_bytes: number;
}

/** Asks for confirmation, then moves the files to the trash and removes them from the library. */
export async function deleteMedia(target: DeleteTarget): Promise<boolean> {
  const store = useLibraryStore.getState();
  const { movies, episodesBySeries, settings, playback } = store;

  let movieRows: { id: number; file_path: string }[] = [];
  let episodeRows: EpisodeRow[] = [];
  let seriesId: number | null = null;
  let label: string;
  let poster: string | null;
  if (target.kind === 'movie') {
    const { item } = target;
    movieRows = target.versionId != null
      ? movies.filter((m) => m.id === target.versionId)
      : movies.filter((m) => m.id === item.id || (item.tmdbId != null && m.tmdb_id === item.tmdbId));
    label = item.year ? `${item.title} (${item.year})` : item.title;
    if (target.versionId != null) {
      const v = item.versions.find((x) => x.id === target.versionId);
      if (v) label += ` · ${v.label}`;
    }
    poster = item.poster;
  } else if (target.kind === 'tv') {
    episodeRows = episodesBySeries.get(target.item.id) ?? [];
    seriesId = target.item.id;
    label = target.item.title;
    poster = target.item.poster;
  } else {
    episodeRows = [target.episode];
    seriesId = target.episode.series_id;
    label = `${target.series.title} · ${epLabel(target.episode)} · ${target.episode.title}`;
    poster = target.episode.still_path ?? target.series.poster;
  }

  const movieIds = movieRows.map((m) => m.id);
  const episodeIds = episodeRows.map((e) => e.id);
  const fileCount = movieIds.length + episodeIds.length;
  if (!fileCount) return false;

  if (
    playback.active &&
    ((playback.type === 'movie' && movieIds.includes(playback.id ?? -1)) ||
      (playback.type === 'episode' && episodeIds.includes(playback.id ?? -1)))
  ) {
    store.toast('Stop playback in VLC before deleting this title.', 'error');
    return false;
  }

  const allPaths = new Set([...movieRows.map((m) => m.file_path), ...episodeRows.map((e) => e.file_path)]);
  const matchingTorrents = store.torrents.filter(
    (t) => t.filePaths.some((p) => allPaths.has(p)) || t.files.some((f) => allPaths.has(f.full_path)),
  );
  const transientTorrent = matchingTorrents.find((t) => t.mode === 'stream' || !t.finished);

  if (transientTorrent) {
    const ok = await store.confirm({
      title: `Remove “${label}”?`,
      message:
        transientTorrent.mode === 'stream'
          ? `This will clear the temporary stream cache for “${label}” immediately.`
          : `This will cancel the active download for “${label}” and delete any partial files.`,
      confirmLabel: transientTorrent.mode === 'stream' ? 'Clear Stream' : 'Cancel & Delete',
      danger: true,
    });
    if (!ok) return false;
    for (const t of matchingTorrents) {
      await invoke('torrent_action', { infoHash: t.infoHash, action: 'delete_with_files' }).catch(() => {});
      await db.deleteTorrentRecord(t.infoHash);
    }
    await db.removeLibraryRows(movieIds, episodeIds);
    store.setTorrents(store.torrents.filter((t) => !matchingTorrents.some((m) => m.infoHash === t.infoHash)));
    await store.reload();
    store.toast(
      transientTorrent.mode === 'stream' ? `Cleared stream cache for “${label}”` : `Cancelled download for “${label}”`,
      'info',
    );
    return true;
  }

  const what =
    target.kind === 'tv'
      ? `All ${fileCount} episode${fileCount === 1 ? '' : 's'} (and the show’s folder, if it only holds this show)`
      : fileCount > 1
        ? `All ${fileCount} versions of this movie`
        : target.kind === 'movie' && target.versionId != null
          ? 'This copy of the movie (its other versions stay)'
          : target.kind === 'movie'
            ? 'The movie file (and its folder, if it only holds this movie)'
          : 'The episode file and its subtitles';
  const ok = await store.confirm({
    title: `Delete “${label}”?`,
    message: `${what} will be moved to Recently Deleted in Settings. You can restore it for ${TRASH_RETENTION_DAYS} days before it’s permanently deleted.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;

  // Release any active seeding handles before moving files on disk (critical on Windows).
  for (const t of matchingTorrents) {
    await invoke('torrent_action', { infoHash: t.infoHash, action: 'delete_keep_files' }).catch(() => {});
    await db.deleteTorrentRecord(t.infoHash);
  }
  if (matchingTorrents.length) {
    store.setTorrents(store.torrents.filter((t) => !matchingTorrents.some((m) => m.infoHash === t.infoHash)));
  }

  // Group by media folder so each trash entry stays on the same drive as its files.
  const allRows = [...movieRows.map((r) => ({ ...r, type: 'movie' as const })), ...episodeRows.map((r) => ({ ...r, type: 'episode' as const }))];
  const groups = new Map<string, typeof allRows>();
  for (const r of allRows) {
    const root = rootFor(r.file_path, settings.media_directories);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }

  let deleted = 0;
  try {
    for (const [root, rows] of groups) {
      const gMovies = rows.filter((r) => r.type === 'movie').map((r) => r.id);
      const gEpisodes = rows.filter((r) => r.type === 'episode').map((r) => r.id);
      const snapshot = await db.snapshotFor(gMovies, gEpisodes, seriesId);
      const res = await invoke<TrashResult>('trash_media', { videoPaths: rows.map((r) => r.file_path), root });
      await db.addTrash({
        label,
        kind: target.kind,
        poster_path: poster,
        entry_dir: res.entry_dir,
        items: JSON.stringify(res.items),
        snapshot: JSON.stringify(snapshot),
        size_bytes: res.size_bytes,
      });
      await db.removeLibraryRows(gMovies, gEpisodes);
      deleted++;
    }
  } catch (e) {
    store.toast(String(e), 'error');
    if (!deleted) return false;
  } finally {
    await store.reload();
  }
  store.toast(`Deleted “${label}” · Restore it from Settings › Recently Deleted`, 'success');
  return true;
}

export const listTrash = db.listTrash;

export async function restoreTrash(row: TrashRow) {
  const store = useLibraryStore.getState();
  const items = JSON.parse(row.items) as FileMove[];
  const res = await invoke<{ restored: number; conflicts: string[] }>('restore_trash', { entryDir: row.entry_dir, items });
  await db.restoreSnapshot(JSON.parse(row.snapshot) as TrashSnapshot);
  if (res.conflicts.length) {
    store.toast(`Some files couldn’t be restored because something already exists there: ${res.conflicts.join(', ')}`, 'error');
  } else {
    await db.deleteTrashRow(row.id);
    store.toast(`Restored “${row.label}”`, 'success');
  }
  await store.reload();
}

export async function purgeTrash(row: TrashRow) {
  await invoke('purge_trash', { entryDir: row.entry_dir });
  await db.deleteTrashRow(row.id);
}

export async function emptyTrash() {
  for (const row of await db.listTrash()) await purgeTrash(row);
}

const parseSqlDate = (s: string) => new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')).getTime();

export function daysLeft(row: TrashRow): number {
  const age = (Date.now() - parseSqlDate(row.deleted_at)) / 864e5;
  return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - age));
}

/** Permanently removes entries older than the retention window (run at startup). */
export async function autoPurgeTrash() {
  for (const row of await db.listTrash()) {
    if (daysLeft(row) <= 0) await purgeTrash(row).catch((e) => console.warn('[trash] purge failed', e));
  }
}
