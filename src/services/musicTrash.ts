import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import { loadMusicLibrary } from '../music/actions';
import { releaseTracks, useMusicPlayer } from '../music/player';
import { askConfirm } from '../music/components/Overlays';
import type { MusicDeleteTarget } from '../music/api';
import type { FileMove } from '../types/media';
import { errorMessage } from '../lib/errors';
import * as db from './db';
import * as mdb from './musicdb';
import { revealInFileManager, rootFor, TRASH_RETENTION_DAYS } from './files';

/**
 * Deleting songs and albums from the music library: their files go to Settings › Recently deleted
 * (the same trash as movies and TV, restored and purged by `restoreTrash` / `purgeTrash`), and they
 * leave the library and their playlists right away.
 */

interface TrashResult {
  entry_dir: string;
  items: FileMove[];
  size_bytes: number;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The songs a target is, in album order, with how it's named in the confirmation and in Recently deleted. */
function describe(target: MusicDeleteTarget) {
  const { library, byId } = useMusicPlayer.getState();
  if (target.kind === 'album') {
    const album = library?.albums.find((a) => a.id === target.albumId);
    if (!album) return null;
    return { ids: album.trackIds, label: `${album.title} · ${album.artist}`, title: `Delete the album “${album.title}”?`, art: album.art };
  }
  const ids = target.kind === 'song' ? [target.trackId] : target.trackIds;
  const first = byId.get(ids[0]);
  if (!first) return null;
  if (ids.length === 1) return { ids, label: `${first.title} · ${first.artist}`, title: `Delete “${first.title}”?`, art: first.art };
  return { ids, label: plural(ids.length, 'song'), title: `Delete ${plural(ids.length, 'song')}?`, art: first.art };
}

/** Asks first, then moves the files to Recently deleted and takes the songs out of the library. */
export async function deleteMusic(target: MusicDeleteTarget): Promise<boolean> {
  const store = useLibraryStore.getState();
  const what = describe(target);
  if (!what?.ids.length) return false;
  const files = (await Promise.all(what.ids.map((id) => mdb.musicTrackFile(id)))).filter((f): f is mdb.MusicTrackFile => !!f);
  if (!files.length) return false;

  const count = files.length;
  const message = [
    target.kind === 'album'
      ? `${count === 1 ? 'Its song' : `All ${count} songs`} will be moved to Recently deleted in Settings, with the album’s folder and cover art if the folder holds nothing else.`
      : `${count === 1 ? 'The song' : `The ${count} songs`} will be moved to Recently deleted in Settings.`,
    `${count === 1 ? 'It leaves' : 'They leave'} your library and playlists now. You can restore ${count === 1 ? 'it' : 'them'} for ${TRASH_RETENTION_DAYS} days, then ${count === 1 ? 'it’s' : 'they’re'} deleted for good.`,
  ].join(' ');
  if (!(await askConfirm(what.title, message, 'Delete'))) return false;

  // The song playing (or about to) lets go of its file, which is about to move.
  releaseTracks(new Set(files.map((f) => f.id)));

  // One Recently deleted entry per music folder, so each stays on the same drive as its files.
  const roots = store.settings.music_directories ?? [];
  const groups = new Map<string, mdb.MusicTrackFile[]>();
  for (const f of files) {
    const root = rootFor(f.file_path, roots);
    if (!root) {
      store.toast(`“${f.title}” isn’t in one of your music folders, so it can’t be deleted here.`, 'error');
      return false;
    }
    groups.set(root, [...(groups.get(root) ?? []), f]);
  }

  try {
    for (const [, songs] of groups) {
      const snapshot = await mdb.musicTrashSnapshot(songs.map((s) => s.id));
      const res = await invoke<TrashResult>('trash_music', { paths: songs.map((s) => s.file_path) });
      try {
        await db.addTrash({
          label: groups.size > 1 ? `${what.label} (${plural(songs.length, 'song')})` : what.label,
          kind: target.kind === 'album' ? 'album' : 'song',
          poster_path: what.art ?? null,
          entry_dir: res.entry_dir,
          items: JSON.stringify(res.items),
          snapshot: JSON.stringify(snapshot),
          size_bytes: res.size_bytes,
        });
      } catch (e) {
        // Without its Recently deleted entry the files couldn't be restored or cleaned up: put them back.
        await invoke('restore_trash', { entryDir: res.entry_dir, items: res.items }).catch(() => {});
        throw e;
      }
      await mdb.removeMusicPaths(songs.map((s) => s.file_path));
    }
  } catch (e) {
    store.toast(`Couldn’t delete “${what.label}”: ${errorMessage(e)}`, 'error');
    return false;
  } finally {
    await loadMusicLibrary(true);
  }
  store.toast(`Deleted “${what.label}” · Restore it from Settings › Recently deleted`, 'success');
  return true;
}

/** Shows a song (or an album's first song) in File Explorer / Finder, selected. */
export async function revealMusic(trackIds: number[]) {
  const file = trackIds.length ? await mdb.musicTrackFile(trackIds[0]) : null;
  if (!file) throw new Error('This song is no longer in your library');
  await revealInFileManager(file.file_path);
}
