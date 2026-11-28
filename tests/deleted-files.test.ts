import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { memoryDb } from './sqlite';

// Files deleted outside the app (File Explorer, Finder) leave the library; a folder that's missing,
// or isn't the folder it was, empties nothing; files that come back get back what they had.

let conn = memoryDb();
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn(async () => conn) } }));
vi.mock('../src/music/actions', () => ({ loadMusicLibrary: vi.fn(async () => {}) }));
vi.mock('../src/services/enrich', () => ({ startBackgroundAnalysis: vi.fn() }));
vi.mock('../src/services/nas', () => ({ reconnectOfflineShares: vi.fn(async () => []), refreshShares: vi.fn(async () => {}), hasNetworkFolders: () => false }));
vi.mock('../src/services/imdb', () => ({ imdbSyncDue: vi.fn(async () => false), syncImdbRatings: vi.fn() }));

type MusicFile = import('../src/services/musicdb').MusicFile;
const song = (path: string, n: number): MusicFile => ({
  file_path: path,
  file_size: 1000 + n,
  mtime: 1,
  title: `Song ${n}`,
  artist: 'Luma',
  album_artist: 'Luma',
  album: 'Neon',
  genre: null,
  track_no: n,
  track_total: null,
  disc_no: null,
  disc_total: null,
  year: 2023,
  duration: 200,
  codec: 'mp3',
  sample_rate: 44100,
  bit_depth: null,
  bitrate: 320000,
  channels: 2,
  cover: null,
  lyrics: null,
  lyrics_source: null,
  error: null,
});

/** The disk as the Rust side sees it. */
const disk = {
  /** Folders that are there (check_paths), and which folder each one is (folder_ids). */
  folders: new Map<string, { id: string; home?: boolean }>(),
  songs: new Map<string, MusicFile>(),
  videos: new Map<string, { file_path: string; filename: string; parent_folder_name: string; grandparent_folder_name: string; file_size: number; mtime: number }>(),
};

function fakeRust() {
  vi.mocked(invoke).mockImplementation((async (cmd: string, args: Record<string, unknown> = {}) => {
    const paths = (args.paths as string[]) ?? [];
    const under = (p: string, root: string) => p.replace(/\\/g, '/').toLowerCase().startsWith(`${root.replace(/\\/g, '/').toLowerCase()}/`);
    switch (cmd) {
      case 'check_paths':
        return paths.map((p) => disk.folders.has(p) || disk.songs.has(p) || disk.videos.has(p));
      case 'folder_ids':
        return paths.map((p) => (disk.folders.has(p) ? { id: disk.folders.get(p)!.id, home: !!disk.folders.get(p)!.home } : { id: null, home: false }));
      case 'music_scan': {
        const known = args.known as Record<string, number>;
        const here = [...disk.songs.values()].filter((f) => paths.some((r) => under(f.file_path, r)));
        return { seen: here.map((f) => f.file_path), changed: here.filter((f) => args.force || known[f.file_path] !== f.mtime), unreadable: [] };
      }
      case 'scan_media_folders':
        return { files: [...disk.videos.values()].filter((f) => paths.some((r) => under(f.file_path, r))), unreadable: [] };
      default:
        return null;
    }
  }) as never);
}

beforeEach(async () => {
  conn = memoryDb();
  vi.resetModules();
  disk.folders.clear();
  disk.songs.clear();
  disk.videos.clear();
  fakeRust();
});

describe('which folders may be emptied', () => {
  it('only a folder that is still the folder its files were in', async () => {
    const { heldRoots } = await import('../src/services/libraryRoots');
    const had = () => 30;
    const all = () => 30;
    const some = () => 3;
    const ids = (id: string | null, home = false) => new Map([['D:\\Music', { id, home }]]);
    const was = new Map([['d:/music', 'disk1-folder7']]);
    // Every file deleted from the same folder: emptied.
    expect(heldRoots(['D:\\Music'], had, all, ids('disk1-folder7'), was)).toEqual([]);
    // Another folder at its path (an empty mount point, another disk on D:): held, however few.
    expect(heldRoots(['D:\\Music'], had, all, ids('disk2-folder1'), was)).toEqual(['D:\\Music']);
    expect(heldRoots(['D:\\Music'], () => 2, () => 2, ids('disk2-folder1'), was)).toEqual(['D:\\Music']);
    // Not all of them gone: nothing to hold.
    expect(heldRoots(['D:\\Music'], had, some, ids('disk2-folder1'), was)).toEqual([]);
    // Never seen before: on the system disk it can't be another disk; elsewhere many are held.
    expect(heldRoots(['D:\\Music'], had, all, ids('disk1-folder7', true), new Map())).toEqual([]);
    expect(heldRoots(['D:\\Music'], had, all, ids('disk3-folder2'), new Map())).toEqual(['D:\\Music']);
    expect(heldRoots(['D:\\Music'], () => 5, () => 5, ids(null), new Map())).toEqual([]);
    // A full rescan the user asked for empties it anyway.
    expect(heldRoots(['D:\\Music'], had, all, ids('disk2-folder1'), was, true)).toEqual([]);
  });

  it('never drops songs of a folder that is offline', async () => {
    const { goneMusicPaths } = await import('../src/services/music');
    const album = Array.from({ length: 30 }, (_, i) => `E:\\Music\\${i}.mp3`);
    expect(goneMusicPaths(album, new Set(), ['E:\\Music'], ['E:\\Music'])).toEqual([]);
    // The same folder as before, with every song deleted: all go.
    const ids = new Map([['E:\\Music', { id: 'v1-f1', home: false }]]);
    expect(goneMusicPaths(album, new Set(), ['E:\\Music'], [], [], false, ids, new Map([['e:/music', 'v1-f1']]))).toEqual(album);
    expect(goneMusicPaths(album, new Set(), ['E:\\Music'], [], [], false, ids, new Map([['e:/music', 'v9-f9']]))).toEqual([]);
  });
});

describe('music', () => {
  const ROOT = 'D:\\Music';
  const paths = Array.from({ length: 25 }, (_, i) => `${ROOT}\\Luma\\Neon\\${String(i + 1).padStart(2, '0')} Song.mp3`);

  async function setup() {
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: [ROOT], media_directories: [] }, activeProfile: { id: 1 } as never }));
    const music = await import('../src/services/music');
    const mdb = await import('../src/services/musicdb');
    disk.folders.set(ROOT, { id: 'vol1-f42' });
    paths.forEach((p, i) => disk.songs.set(p, song(p, i + 1)));
    await music.runMusicScan({ quiet: true });
    const lib = await mdb.loadMusic(1);
    expect(lib.tracks).toHaveLength(25);
    const id = (n: number) => lib.tracks.find((t) => t.title === `Song ${n}`)!.id;
    const pl = await mdb.createPlaylist(1, 'Mix', [id(1), id(2), id(3)]);
    await mdb.setFavourite(1, id(2), true);
    await mdb.recordPlay(1, id(3), 1000);
    return { music, mdb, pl, useLibraryStore };
  }

  it('drops songs deleted from a folder that is there, and keeps their playlists', async () => {
    const { music, mdb, pl } = await setup();
    // One song deleted.
    disk.songs.delete(paths[0]);
    await music.runMusicScan({ quiet: true });
    let lib = await mdb.loadMusic(1);
    expect(lib.tracks).toHaveLength(24);
    expect(lib.playlists.find((p) => p.id === pl.id)!.trackIds).toHaveLength(2);
    // Every song deleted, folder still there (and the same folder): all go, albums and artists too.
    disk.songs.clear();
    await music.runMusicScan({ quiet: true });
    lib = await mdb.loadMusic(1);
    expect(lib.tracks).toEqual([]);
    expect(lib.albums).toEqual([]);
    expect(lib.artists).toEqual([]);
    // The playlist stays, empty.
    expect(lib.playlists.find((p) => p.id === pl.id)).toMatchObject({ name: 'Mix', trackIds: [] });
  });

  it('removes nothing when the folder is missing or is another folder', async () => {
    const { music, mdb } = await setup();
    // An unplugged drive, an offline share: the folder isn't there.
    disk.folders.delete(ROOT);
    await music.runMusicScan({ quiet: true });
    expect((await mdb.loadMusic(1)).tracks).toHaveLength(25);
    // An empty mount point, or another disk on D:, at the same path.
    disk.folders.set(ROOT, { id: 'vol2-f1' });
    disk.songs.clear();
    await music.runMusicScan({ quiet: true });
    expect((await mdb.loadMusic(1)).tracks).toHaveLength(25);
  });

  it('gives songs that come back their playlist places, favourites and plays', async () => {
    const { music, mdb, pl } = await setup();
    const before = await mdb.loadMusic(1);
    disk.songs.clear();
    await music.runMusicScan({ quiet: true });
    expect((await mdb.loadMusic(1)).tracks).toEqual([]);
    // Put back (copied back, or downloaded again to the same place).
    paths.forEach((p, i) => disk.songs.set(p, song(p, i + 1)));
    await music.runMusicScan({ quiet: true });
    const lib = await mdb.loadMusic(1);
    expect(lib.tracks).toHaveLength(25);
    const t = (n: number) => lib.tracks.find((x) => x.title === `Song ${n}`)!;
    expect(lib.playlists.find((p) => p.id === pl.id)!.trackIds).toEqual([t(1).id, t(2).id, t(3).id]);
    expect(t(2).favourite).toBe(true);
    expect(t(3).plays).toBe(1);
    expect(lib.albums).toHaveLength(1);
    expect(before.tracks.length).toBe(25);
    // Nothing left waiting to come back.
    expect(await conn.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM music_missing')).toEqual([{ n: 0 }]);
  });

  it('puts a song back at the end of a playlist that changed meanwhile, and not into a deleted one', async () => {
    const { music, mdb, pl } = await setup();
    const other = await mdb.createPlaylist(1, 'Other', [(await mdb.loadMusic(1)).tracks.find((t) => t.title === 'Song 1')!.id]);
    disk.songs.delete(paths[0]);
    await music.runMusicScan({ quiet: true });
    const lib = await mdb.loadMusic(1);
    const s5 = lib.tracks.find((t) => t.title === 'Song 5')!.id;
    // Reordered meanwhile: Song 1's place is taken.
    await mdb.setPlaylistTracks(1, pl.id, [s5, ...lib.playlists.find((p) => p.id === pl.id)!.trackIds]);
    await mdb.deletePlaylist(1, other.id);
    disk.songs.set(paths[0], song(paths[0], 1));
    await music.runMusicScan({ quiet: true });
    const after = await mdb.loadMusic(1);
    const s1 = after.tracks.find((t) => t.title === 'Song 1')!.id;
    expect(after.playlists.find((p) => p.id === pl.id)!.trackIds.at(-1)).toBe(s1);
    expect(after.playlists.find((p) => p.id === other.id)).toBeUndefined();
  });

  it('an import does not count a deleted song as owned', async () => {
    const { music, mdb, useLibraryStore } = await setup();
    const { ownedSong } = await import('../src/services/playlistImport');
    const tracks = (await mdb.loadMusic(1)).tracks;
    const want = { title: 'Song 4', artists: ['Luma'] };
    expect((await ownedSong(want, null, tracks))?.title).toBe('Song 4');
    // Deleted in File Explorer; the library (in memory) still lists it.
    disk.songs.delete(paths[3]);
    expect(await music.songFileGone(tracks.find((t) => t.title === 'Song 4')!.id)).toBe(true);
    expect(await ownedSong(want, null, tracks)).toBeNull();
    // A song in a folder that's offline is still owned.
    disk.folders.delete(ROOT);
    expect((await ownedSong({ title: 'Song 6', artists: ['Luma'] }, null, tracks))?.title).toBe('Song 6');
    expect(useLibraryStore.getState().settings.music_directories).toEqual([ROOT]);
  });
});

describe('movies and TV', () => {
  const ROOT = 'D:\\Videos';
  const moviePath = `${ROOT}\\Inception (2010)\\Inception.mkv`;
  const episodePaths = [1, 2].map((n) => `${ROOT}\\Severance\\Season 1\\Severance S01E0${n}.mkv`);
  const extras = Array.from({ length: 25 }, (_, i) => `${ROOT}\\Shorts\\Short ${i}.mkv`);

  const video = (file_path: string, size = 5_000_000) => {
    const parts = file_path.split('\\');
    return { file_path, filename: parts.at(-1)!, parent_folder_name: parts.at(-2)!, grandparent_folder_name: parts.at(-3)!, file_size: size, mtime: 7 };
  };

  async function setup() {
    const db = await import('../src/services/db');
    const conn_ = await db.getDb();
    await conn_.execute("INSERT INTO movies (tmdb_id, file_path, raw_filename, file_mtime, file_size, title) VALUES (27205, $1, 'Inception.mkv', 7, 5000000, 'Inception')", [moviePath]);
    await conn_.execute("INSERT INTO tv_series (tmdb_id, title) VALUES (95396, 'Severance')");
    for (const [i, p] of episodePaths.entries()) {
      await conn_.execute(
        "INSERT INTO episodes (series_id, file_path, raw_filename, file_mtime, file_size, season_number, episode_number, title) VALUES (1, $1, $2, 7, 5000000, 1, $3, $4)",
        [p, p.split('\\').at(-1), i + 1, `Episode ${i + 1}`],
      );
    }
    for (const [i, p] of extras.entries()) {
      await conn_.execute("INSERT INTO movies (tmdb_id, file_path, raw_filename, file_mtime, file_size, title) VALUES ($1, $2, 'x.mkv', 7, $3, 'Short')", [1000 + i, p, 1000 + i]);
    }
    // Watched Inception, half way through episode 1, the show on My List.
    await conn_.execute("INSERT INTO profile_state (profile_id, media_type, media_id, progress_seconds, duration_seconds, watched) VALUES (1, 'movie', 1, 8800, 8880, 1)");
    await conn_.execute("INSERT INTO profile_state (profile_id, media_type, media_id, progress_seconds, duration_seconds) VALUES (1, 'episode', 1, 1500, 3000)");
    await conn_.execute("INSERT INTO profile_state (profile_id, media_type, media_id, my_list) VALUES (1, 'tv', 1, 1)");
    disk.folders.set(ROOT, { id: 'vol1-f9' });
    for (const p of [moviePath, ...episodePaths, ...extras]) disk.videos.set(p, video(p, p.includes('Short') ? 1000 + extras.indexOf(p) : 5_000_000));

    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState((s) => ({
      settings: { ...s.settings, tmdb_api_key: 'key', media_directories: [ROOT], music_directories: [], organize_loose_files: false, imdb_enabled: false },
      reload: vi.fn(async () => {}),
    }));
    const scanner = await import('../src/services/scanner');
    // A first scan with everything there notes which folder D:\Videos is.
    await scanner.runScan({ quiet: true });
    const rows = async () => ({
      movies: (await conn_.select<{ id: number; file_path: string }[]>('SELECT id, file_path FROM movies ORDER BY id')).map((r) => r.file_path),
      episodes: (await conn_.select<{ file_path: string }[]>('SELECT file_path FROM episodes ORDER BY id')).map((r) => r.file_path),
      series: await conn_.select<{ title: string }[]>('SELECT title FROM tv_series'),
    });
    expect((await rows()).movies).toHaveLength(26);
    return { scanner, rows, conn_ };
  }

  it('drops deleted movies and episodes, then an empty show', async () => {
    const { scanner, rows } = await setup();
    disk.videos.delete(moviePath);
    disk.videos.delete(episodePaths[0]);
    await scanner.runScan({ quiet: true });
    let now = await rows();
    expect(now.movies).not.toContain(moviePath);
    expect(now.episodes).toEqual([episodePaths[1]]);
    disk.videos.delete(episodePaths[1]);
    await scanner.runScan({ quiet: true });
    now = await rows();
    expect(now.episodes).toEqual([]);
    expect(now.series).toEqual([]);
    // Everything deleted from the same folder: it all goes.
    disk.videos.clear();
    await scanner.runScan({ quiet: true });
    expect((await rows()).movies).toEqual([]);
  });

  it('removes nothing when the folder is missing or is another folder', async () => {
    const { scanner, rows } = await setup();
    disk.folders.delete(ROOT);
    await scanner.runScan({ quiet: true });
    expect((await rows()).movies).toHaveLength(26);
    disk.folders.set(ROOT, { id: 'vol5-f1' });
    disk.videos.clear();
    await scanner.runScan({ quiet: true });
    expect((await rows()).movies).toHaveLength(26);
    expect((await rows()).episodes).toHaveLength(2);
  });

  it('puts back files that come back as they were: match, progress and My List', async () => {
    const { scanner, rows, conn_ } = await setup();
    disk.videos.delete(moviePath);
    for (const p of episodePaths) disk.videos.delete(p);
    await scanner.runScan({ quiet: true });
    expect((await rows()).series).toEqual([]);
    expect(await conn_.select("SELECT * FROM profile_state WHERE media_type IN ('movie', 'tv') AND my_list + watched > 0")).toEqual([]);
    // Back: the movie where it was, the episodes moved to another folder.
    disk.videos.set(moviePath, video(moviePath));
    for (const p of episodePaths) {
      const moved = p.replace('Season 1', 'S1');
      disk.videos.set(moved, { ...video(moved), mtime: 9 });
    }
    await scanner.runScan({ quiet: true });
    const movie = await conn_.select<{ id: number; tmdb_id: number }[]>('SELECT id, tmdb_id FROM movies WHERE file_path = $1', [moviePath]);
    expect(movie[0].tmdb_id).toBe(27205);
    const state = await conn_.select<{ media_type: string; media_id: number; progress_seconds: number; watched: number; my_list: number }[]>(
      'SELECT media_type, media_id, progress_seconds, watched, my_list FROM profile_state WHERE profile_id = 1 ORDER BY media_type',
    );
    const episodes = await conn_.select<{ id: number; file_path: string; file_mtime: number }[]>('SELECT id, file_path, file_mtime FROM episodes ORDER BY episode_number');
    expect(episodes.map((e) => e.file_path)).toEqual(episodePaths.map((p) => p.replace('Season 1', 'S1')));
    // As the file is now, so it isn't matched again next scan.
    expect(episodes[0].file_mtime).toBe(9);
    const show = await conn_.select<{ id: number }[]>("SELECT id FROM tv_series WHERE tmdb_id = 95396");
    expect(state).toEqual([
      { media_type: 'episode', media_id: episodes[0].id, progress_seconds: 1500, watched: 0, my_list: 0 },
      { media_type: 'movie', media_id: movie[0].id, progress_seconds: 8800, watched: 1, my_list: 0 },
      { media_type: 'tv', media_id: show[0].id, progress_seconds: 0, watched: 0, my_list: 1 },
    ]);
    expect(await conn_.select('SELECT file_path FROM missing_media')).toEqual([]);
  });
});
