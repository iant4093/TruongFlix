import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import { epLabel, episodeVersions, versionLabel } from '../store/selectors';
import type { EpisodeRow, FileMove, MediaItem, TorrentItem, TrashRow, TrashSnapshot } from '../types/media';
import * as db from './db';
import { removeTorrent } from './torrents';
import { IS_MAC, IS_WINDOWS } from '../lib/platform';
import { errorMessage } from '../lib/errors';

export const TRASH_RETENTION_DAYS = 30;

export const FILE_MANAGER_NAME = IS_MAC ? 'Finder' : IS_WINDOWS ? 'File Explorer' : 'file manager';

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
  | { kind: 'episode'; episode: EpisodeRow; series: MediaItem; allVersions?: boolean };

interface TrashResult {
  entry_dir: string;
  items: FileMove[];
  size_bytes: number;
}

function transferContainsPath(torrent: TorrentItem, path: string) {
  return torrent.filePaths.includes(path) || torrent.files.some((file) => file.included && file.full_path === path)
    || (torrent.mode === 'stream' && !!torrent.savePath && !!rootFor(path, [torrent.savePath]));
}

/** Asks for confirmation, then moves the files to the trash and removes them from the library. */
export async function deleteMedia(target: DeleteTarget): Promise<boolean> {
  const store = useLibraryStore.getState();
  const { movies, episodesBySeries, settings, playback, playerSession } = store;

  let movieRows: typeof movies = [];
  let episodeRows: EpisodeRow[] = [];
  let retainedPaths: string[] = [];
  let seriesId: number | null = null;
  let label: string;
  let poster: string | null;
  if (target.kind === 'movie') {
    const { item } = target;
    const copies = movies.filter((m) => m.id === item.id || (item.tmdbId != null && m.tmdb_id === item.tmdbId));
    movieRows = target.versionId == null ? copies : copies.filter((m) => m.id === target.versionId);
    label = item.year ? `${item.title} (${item.year})` : item.title;
    if (target.versionId != null && movieRows.length) {
      retainedPaths = copies.filter((m) => m.id !== target.versionId).map((m) => m.file_path);
      label += ` · ${versionLabel(movieRows[0])}`;
    }
    poster = item.poster;
  } else if (target.kind === 'tv') {
    episodeRows = episodesBySeries.get(target.item.id) ?? [];
    seriesId = target.item.id;
    label = target.item.title;
    poster = target.item.poster;
  } else {
    const copies = episodeVersions(target.episode, episodesBySeries.get(target.episode.series_id) ?? []);
    episodeRows = target.allVersions ? copies : copies.filter((episode) => episode.id === target.episode.id);
    seriesId = target.episode.series_id;
    label = `${target.series.title} · ${epLabel(target.episode)} · ${target.episode.title}`;
    if (!target.allVersions && episodeRows.length && copies.length > 1) {
      retainedPaths = copies.filter((episode) => episode.id !== target.episode.id).map((episode) => episode.file_path);
      label += ` · ${versionLabel(episodeRows[0])}`;
    }
    poster = target.episode.still_path ?? target.series.poster;
  }

  const movieIds = movieRows.map((m) => m.id);
  const episodeIds = episodeRows.map((e) => e.id);
  const fileCount = movieIds.length + episodeIds.length;
  if (!fileCount) return false;

  const playing = [playback.active ? playback : null, playerSession?.target].some((media) =>
    (media?.type === 'movie' && movieIds.includes(media.id ?? -1))
    || (media?.type === 'episode' && episodeIds.includes(media.id ?? -1)));
  if (playing) {
    store.toast('Stop playback of the selected file before deleting it.', 'error');
    return false;
  }

  const allRows = [...movieRows.map((r) => ({ ...r, type: 'movie' as const })), ...episodeRows.map((r) => ({ ...r, type: 'episode' as const }))];
  const matchingTorrents = store.torrents.filter(
    (t) => allRows.some((row) => transferContainsPath(t, row.file_path)),
  );
  const transientTorrents = matchingTorrents.filter((t) => t.mode === 'stream' || (t.inSession && !t.finished));
  const sharedTransfer = transientTorrents.find((t) => retainedPaths.some((path) => transferContainsPath(t, path)));
  if (sharedTransfer) {
    const action = sharedTransfer.mode === 'stream' ? 'Keep the stream in your library' : 'Wait for the download to finish';
    store.toast(`These versions share a transfer. ${action} before deleting individual copies.`, 'error');
    return false;
  }
  const regularRows = allRows.filter((row) => !transientTorrents.some((t) => transferContainsPath(t, row.file_path)));

  const what =
    target.kind === 'tv'
      ? `All ${fileCount} episode file${fileCount === 1 ? '' : 's'} (and the show’s folder, if it only holds this show)`
      : fileCount > 1
        ? `All ${fileCount} versions of this ${target.kind}`
        : retainedPaths.length
          ? `This copy of the ${target.kind}`
          : target.kind === 'movie'
            ? 'The movie file (and its folder, if it only holds this movie)'
          : 'The episode file and its subtitles';
  const trashMessage = `${what} will be moved to Recently deleted in Settings. You can restore it for ${TRASH_RETENTION_DAYS} days before it’s permanently deleted.`;
  const transferMessage = 'Matching transfers will be canceled and their files permanently deleted, including any other episodes they contain.';
  const ok = await store.confirm({
    title: `Delete “${label}”?`,
    message: transientTorrents.length
      ? `${transferMessage}${regularRows.length ? '\n\nThe remaining selected files will be moved to Recently deleted.' : ''}`
      : trashMessage,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;

  // Group by media folder so each trash entry stays on the same drive as its files.
  const groups = new Map<string, typeof allRows>();
  const filesOnly = target.kind === 'episode' || (target.kind === 'movie' && target.versionId != null);
  for (const r of regularRows) {
    const root = rootFor(r.file_path, settings.media_directories);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }

  try {
    for (const torrent of transientTorrents) {
      await removeTorrent(torrent.infoHash, true);
      const rows = allRows.filter((row) => transferContainsPath(torrent, row.file_path));
      await db.removeLibraryRows(
        rows.filter((row) => row.type === 'movie').map((row) => row.id),
        rows.filter((row) => row.type === 'episode').map((row) => row.id),
      );
    }
    // Release any active seeding handles before moving files on disk (critical on Windows).
    const completedTorrents = matchingTorrents.filter((t) => !transientTorrents.includes(t));
    for (const torrent of completedTorrents) {
      await invoke('torrent_action', { infoHash: torrent.infoHash, action: 'delete_keep_files' });
      await db.deleteTorrentRecord(torrent.infoHash);
    }
    if (completedTorrents.length) {
      const current = useLibraryStore.getState();
      current.setTorrents(current.torrents.filter((t) => !completedTorrents.some((completed) => completed.infoHash === t.infoHash)));
    }

    for (const [root, rows] of groups) {
      const gMovies = rows.filter((r) => r.type === 'movie').map((r) => r.id);
      const gEpisodes = rows.filter((r) => r.type === 'episode').map((r) => r.id);
      const snapshot = await db.snapshotFor(gMovies, gEpisodes, seriesId);
      const res = await invoke<TrashResult>('trash_media', {
        videoPaths: rows.map((r) => r.file_path), root, ...(filesOnly ? { filesOnly: true } : {}),
      });
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
    }
  } catch (e) {
    store.toast(`Could not delete “${label}”: ${errorMessage(e)}`, 'error');
    return false;
  } finally {
    await store.reload();
  }
  store.toast(groups.size
    ? `Deleted “${label}” · Restore files from Settings › Recently deleted`
    : `Removed transfers for “${label}”`, 'success');
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
