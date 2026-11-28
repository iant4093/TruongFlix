import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { memoryDb } from './sqlite';

// Songs and albums deleted in Music go to Settings › Recently deleted (the movies' and shows' trash),
// leave the library and playlists right away, and come back as they were on restore.

let conn = memoryDb();
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn(async () => conn) } }));
vi.mock('../src/music/components/Overlays', () => ({ askConfirm: vi.fn(async () => true) }));
vi.mock('../src/music/actions', () => ({
  loadMusicLibrary: vi.fn(async () => {
    const mdb = await import('../src/services/musicdb');
    const { setMusicLibrary } = await import('../src/music/player');
    setMusicLibrary(await mdb.loadMusic(1));
  }),
}));

const ROOT = 'D:\\Music';
const NEON = `${ROOT}\\Luma\\Neon`;
const neon = [1, 2, 3].map((n) => `${NEON}\\0${n} Song ${n}.mp3`);
const single = `${ROOT}\\Luma\\Dusk\\01 Song 4.mp3`;

type MusicFile = import('../src/services/musicdb').MusicFile;
const song = (path: string, n: number, album: string): MusicFile => ({
  file_path: path, file_size: 1000 + n, mtime: 1, title: `Song ${n}`, artist: 'Luma', album_artist: 'Luma', album,
  genre: 'Synthpop', track_no: n, track_total: null, disc_no: null, disc_total: null, year: 2023, duration: 200, codec: 'flac',
  sample_rate: 44100, bit_depth: 16, bitrate: 900000, channels: 2, cover: 'a'.repeat(32) + '.jpg', lyrics: '[00:01.00] hi', lyrics_source: 'sidecar', error: null,
});

/** Files on disk, and what the Rust side was asked to do. */
const disk = new Set<string>();
const trash = new Map<string, string[]>();
let failMove = false;

function fakeRust() {
  vi.mocked(invoke).mockImplementation((async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case 'trash_music': {
        if (failMove) throw new Error('Access is denied.');
        const paths = args.paths as string[];
        const entry = `${ROOT}\\.truongflix-trash\\1700000000-0a1b2c3d${trash.size}`;
        for (const p of paths) disk.delete(p);
        trash.set(entry, paths);
        return { entry_dir: entry, items: paths.map((p, i) => ({ from: p, to: `${entry}\\${i}\\${p.split('\\').pop()}` })), size_bytes: 1000 * paths.length };
      }
      case 'restore_trash': {
        const paths = trash.get(args.entryDir as string) ?? [];
        for (const p of paths) disk.add(p);
        trash.delete(args.entryDir as string);
        return { restored: paths.length, conflicts: [] };
      }
      case 'purge_trash':
        trash.delete(args.entryDir as string);
        return null;
      default:
        return null;
    }
  }) as never);
}

beforeEach(() => {
  conn = memoryDb();
  vi.resetModules();
  vi.mocked(invoke).mockReset();
  disk.clear();
  trash.clear();
  failMove = false;
  fakeRust();
});

async function setup() {
  const { useLibraryStore } = await import('../src/store/useLibraryStore');
  const toast = vi.fn();
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: [ROOT] }, activeProfile: { id: 1 } as never, toast }));
  const mdb = await import('../src/services/musicdb');
  const actions = await import('../src/music/actions');
  const files = [...neon.map((p, i) => song(p, i + 1, 'Neon')), song(single, 4, 'Dusk')];
  for (const f of files) disk.add(f.file_path);
  await mdb.upsertMusicFiles(files, 1000, [ROOT]);
  let lib = await mdb.loadMusic(1);
  const id = (n: number) => lib.tracks.find((t) => t.title === `Song ${n}`)!.id;
  const album = lib.albums.find((a) => a.title === 'Neon')!;
  const pl = await mdb.createPlaylist(1, 'Mix', [id(4), id(2), id(1)]);
  await mdb.setFavourite(1, id(2), true);
  await mdb.recordPlay(1, id(1), 2000);
  await mdb.recordPlay(1, id(1), 3000);
  await mdb.setPinned(1, 'album', album.id, true);
  await mdb.saveLyricsCache(id(3), { synced: '[00:01.00] online', plain: null, instrumental: false, provider: 'lrclib', lookup: 3 });
  await actions.loadMusicLibrary(true);
  lib = await mdb.loadMusic(1);
  const trashMod = await import('../src/services/musicTrash');
  const filesMod = await import('../src/services/files');
  const { askConfirm } = await import('../src/music/components/Overlays');
  return { mdb, lib, id, album, pl, toast, deleteMusic: trashMod.deleteMusic, files: filesMod, askConfirm: vi.mocked(askConfirm) };
}

const trashRows = () => conn.select<{ id: number; label: string; kind: string; poster_path: string | null; items: string; snapshot: string }[]>('SELECT * FROM trash');

describe('deleting music', () => {
  it('an album goes to Recently deleted, leaves the library and its playlists, and comes back as it was', async () => {
    const { mdb, lib, id, album, pl, deleteMusic, files, askConfirm } = await setup();
    const before = lib.tracks.filter((t) => t.albumId === album.id);

    expect(await deleteMusic({ kind: 'album', albumId: album.id })).toBe(true);
    expect(askConfirm).toHaveBeenCalledWith('Delete the album “Neon”?', expect.stringContaining('Recently deleted'), 'Delete');
    expect(askConfirm.mock.calls[0][1]).toContain('album’s folder and cover art');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('trash_music', { paths: neon });
    // Out of the library and the playlist right away; the other album stays.
    let now = await mdb.loadMusic(1);
    expect(now.tracks.map((t) => t.title)).toEqual(['Song 4']);
    expect(now.albums.map((a) => a.title)).toEqual(['Dusk']);
    expect(now.playlists.find((p) => p.id === pl.id)!.trackIds).toEqual([id(4)]);
    expect(now.pins).toEqual([]);
    const { useMusicPlayer } = await import('../src/music/player');
    expect(useMusicPlayer.getState().library!.tracks).toHaveLength(1);
    // In Recently deleted, with the album's cover.
    const [row] = await trashRows();
    expect(row).toMatchObject({ label: 'Neon · Luma', kind: 'album', poster_path: 'a'.repeat(32) + '.jpg' });

    // Restored: the files come back, and so do the songs with everything they had.
    await files.restoreTrash((await files.listTrash())[0]);
    expect([...disk]).toEqual(expect.arrayContaining(neon));
    now = await mdb.loadMusic(1);
    expect(now.tracks).toHaveLength(4);
    const back = (n: number) => now.tracks.find((t) => t.title === `Song ${n}`)!;
    expect(now.albums.find((a) => a.title === 'Neon')).toMatchObject({ artist: 'Luma', art: album.art });
    expect(now.playlists.find((p) => p.id === pl.id)!.trackIds).toEqual([id(4), back(2).id, back(1).id]);
    expect(back(2).favourite).toBe(true);
    expect(back(1).plays).toBe(2);
    expect(now.pins).toEqual([{ kind: 'album', id: back(1).albumId }]);
    for (const t of before) {
      expect(now.tracks.find((x) => x.title === t.title)).toMatchObject({ trackNo: t.trackNo, genre: t.genre, codec: t.codec, art: t.art, hasLyrics: true, addedAt: t.addedAt });
    }
    expect((await mdb.cachedLyrics(back(3).id))?.synced).toBe('[00:01.00] online');
    expect(useMusicPlayer.getState().library!.tracks).toHaveLength(4);
    // The entry is gone from Recently deleted.
    expect(await trashRows()).toEqual([]);
    // The next scan finds the files where they were and changes nothing.
    expect(await mdb.musicFileIndex()).toSatisfy((index: Map<string, unknown>) => neon.every((p) => index.has(p)));
  });

  it('a song leaves the library and its playlists; deleting it for good removes only the entry', async () => {
    const { mdb, id, pl, deleteMusic, files, askConfirm } = await setup();
    expect(await deleteMusic({ kind: 'song', trackId: id(2) })).toBe(true);
    expect(askConfirm).toHaveBeenCalledWith('Delete “Song 2”?', expect.stringContaining('The song will be moved to Recently deleted in Settings.'), 'Delete');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('trash_music', { paths: [neon[1]] });
    const now = await mdb.loadMusic(1);
    expect(now.tracks.map((t) => t.title).sort()).toEqual(['Song 1', 'Song 3', 'Song 4']);
    expect(now.playlists.find((p) => p.id === pl.id)!.trackIds).toEqual([id(4), id(1)]);
    const [row] = await trashRows();
    expect(row).toMatchObject({ label: 'Song 2 · Luma', kind: 'song' });

    await files.purgeTrash((await files.listTrash())[0]);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('purge_trash', { entryDir: expect.stringContaining('.truongflix-trash') });
    expect(await trashRows()).toEqual([]);
    expect((await mdb.loadMusic(1)).tracks).toHaveLength(3);
  });

  it('stops the song if it is the one playing', async () => {
    const { id, deleteMusic } = await setup();
    const player = await import('../src/music/player');
    player.useMusicPlayer.setState({ track: player.useMusicPlayer.getState().byId.get(id(1))!, playing: true });
    await deleteMusic({ kind: 'song', trackId: id(1) });
    expect(player.useMusicPlayer.getState().track).toBeNull();
  });

  it('nothing happens when the question is answered no', async () => {
    const { mdb, id, deleteMusic, askConfirm } = await setup();
    askConfirm.mockResolvedValueOnce(false);
    expect(await deleteMusic({ kind: 'song', trackId: id(1) })).toBe(false);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('trash_music', expect.anything());
    expect((await mdb.loadMusic(1)).tracks).toHaveLength(4);
    expect(await trashRows()).toEqual([]);
  });

  it('keeps everything when the files could not be moved', async () => {
    const { mdb, album, deleteMusic, toast } = await setup();
    failMove = true;
    expect(await deleteMusic({ kind: 'album', albumId: album.id })).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Couldn’t delete “Neon · Luma”'), 'error');
    expect((await mdb.loadMusic(1)).tracks).toHaveLength(4);
    expect(await trashRows()).toEqual([]);
  });

  it('only deletes songs inside the music folders', async () => {
    const { mdb, id, deleteMusic, toast } = await setup();
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    // The folder was taken out of Settings: its songs can't be deleted from here.
    useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: ['E:\\Other'] } }));
    expect(await deleteMusic({ kind: 'song', trackId: id(1) })).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('isn’t in one of your music folders'), 'error');
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('trash_music', expect.anything());
    expect((await mdb.loadMusic(1)).tracks).toHaveLength(4);
  });
});

describe('show in folder', () => {
  it('shows the song, or the first song of an album, in File Explorer / Finder', async () => {
    const { id, lib, album } = await setup();
    const { revealMusic } = await import('../src/services/musicTrash');
    await revealMusic([id(3)]);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('reveal_in_file_manager', { path: neon[2] });
    await revealMusic(lib.albums.find((a) => a.id === album.id)!.trackIds);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('reveal_in_file_manager', { path: neon[0] });
  });
});
