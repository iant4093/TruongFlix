import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from './sqlite';

let conn = memoryDb();
vi.mock('../src/services/db', () => ({ getDb: vi.fn(async () => conn) }));

type Mdb = typeof import('../src/services/musicdb');
let mdb: Mdb;

const file = (path: string, patch: Partial<import('../src/services/musicdb').MusicFile> = {}): import('../src/services/musicdb').MusicFile => ({
  file_path: path,
  file_size: 1000,
  mtime: 1,
  title: null,
  artist: null,
  album_artist: null,
  album: null,
  genre: null,
  track_no: null,
  track_total: null,
  disc_no: null,
  disc_total: null,
  year: null,
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
  ...patch,
});

async function seed() {
  await mdb.upsertMusicFiles([
    file('/m/A/01 Intro.mp3', { title: 'Intro', artist: 'Luma', album: 'Neon', track_no: 1, year: 2023, cover: 'a'.repeat(32) + '.jpg' }),
    file('/m/A/02 Song.mp3', { title: 'Song', artist: 'Guest', album_artist: 'Luma', album: 'Neon', track_no: 2 }),
    file('/m/B/x.flac', { title: 'Other', artist: 'luma', album: 'Echo', codec: 'flac' }),
    file('/m/loose/07 - Untagged Track.wav', { codec: 'wav' }),
  ], 1, ['/m']);
  const lib = await mdb.loadMusic(1);
  return Object.fromEntries(lib.tracks.map((t) => [t.title, t]));
}

beforeEach(async () => {
  conn = memoryDb();
  vi.resetModules();
  mdb = await import('../src/services/musicdb');
});

describe('music library tables', () => {
  it('groups songs into albums and artists', async () => {
    const t = await seed();
    const lib = await mdb.loadMusic(1);
    expect(lib.tracks).toHaveLength(4);
    // Artist names are matched case-insensitively.
    expect(t.Other.artistId).toBe(t.Intro.artistId);
    expect(t.Song.albumArtist).toBe('Luma');
    expect(t.Song.artist).toBe('Guest');
    const neon = lib.albums.find((a) => a.title === 'Neon')!;
    expect(neon.trackIds).toEqual([t.Intro.id, t.Song.id]);
    expect(neon.art).toBe('a'.repeat(32) + '.jpg');
    const luma = lib.artists.find((a) => a.name === 'Luma')!;
    expect(luma.albumIds).toHaveLength(2);
    // Untagged files are named after the file, and their album after the folder.
    expect(t['Untagged Track']).toBeDefined();
    expect(t['Untagged Track'].artist).toBe('Unknown Artist');
    expect(t['Untagged Track'].album).toBe('loose');
    expect(t['Untagged Track'].trackNo).toBe(7);
  });

  it('updates changed files and removes gone ones (with their playlist entries)', async () => {
    const t = await seed();
    const pl = await mdb.createPlaylist(1, 'Mix', [t.Intro.id, t.Other.id]);
    await mdb.setFavourite(1, t.Other.id, true);
    await mdb.upsertMusicFiles([file('/m/A/01 Intro.mp3', { title: 'Intro (Remastered)', artist: 'Luma', album: 'Neon', mtime: 2 })]);
    await mdb.removeMusicPaths(['/m/B/x.flac']);
    const lib = await mdb.loadMusic(1);
    expect(lib.tracks.map((x) => x.title).sort()).toEqual(['Intro (Remastered)', 'Song', 'Untagged Track']);
    expect(lib.albums.map((a) => a.title).sort()).toEqual(['Neon', 'loose']); // "Echo" had no songs left
    expect(lib.playlists.find((p) => p.id === pl.id)!.trackIds).toEqual([t.Intro.id]);
    const index = await mdb.musicFileIndex();
    expect(index.get('/m/A/01 Intro.mp3')).toEqual({ id: t.Intro.id, mtime: 2 });
  });

  it('keeps featured artists and compilations on one album', async () => {
    await mdb.upsertMusicFiles([
      file('/m/Calvin/Motion/01.mp3', { title: 'One', artist: 'Calvin Harris', album: 'Motion' }),
      file('/m/Calvin/Motion/02.mp3', { title: 'Two', artist: 'Calvin Harris feat. Ellie Goulding', album: 'Motion' }),
      file('/m/Hits/01.mp3', { title: 'A', artist: 'Artist A', album: 'Now Hits' }),
      file('/m/Hits/02.mp3', { title: 'B', artist: 'Artist B', album: 'Now Hits' }),
      file('/m/Hits/03.mp3', { title: 'C', artist: 'Artist C', album: 'Now Hits' }),
      file('/m/Wall/CD1/01.mp3', { title: 'In the Flesh?', artist: 'Pink Floyd', album: 'The Wall (Disc 1)' }),
      file('/m/Wall/CD2/01.mp3', { title: 'Hey You', artist: 'Pink Floyd', album: 'The Wall (Disc 2)' }),
    ], 1, ['/m']);
    // A song added later joins its album.
    await mdb.upsertMusicFiles([file('/m/Hits/04.mp3', { title: 'D', artist: 'Artist D', album: 'Now Hits' })], 2, ['/m']);
    const lib = await mdb.loadMusic(1);
    const byTitle = (title: string) => lib.albums.filter((a) => a.title === title);
    expect(byTitle('Motion')).toHaveLength(1);
    expect(byTitle('Motion')[0].artist).toBe('Calvin Harris');
    expect(byTitle('Now Hits')).toHaveLength(1);
    expect(byTitle('Now Hits')[0]).toMatchObject({ artist: 'Various Artists' });
    expect(byTitle('Now Hits')[0].trackIds).toHaveLength(4);
    const wall = byTitle('The Wall');
    expect(wall).toHaveLength(1);
    expect(wall[0].trackIds.map((id) => lib.tracks.find((t) => t.id === id)!.discNo)).toEqual([1, 2]);
  });

  it('keeps plays and favourites per profile', async () => {
    const t = await seed();
    await mdb.recordPlay(1, t.Song.id, 1000);
    await mdb.recordPlay(1, t.Song.id, 2000);
    await mdb.setFavourite(1, t.Song.id, true);
    expect(await mdb.recordPlay(1, 999)).toBe(false);
    const mine = (await mdb.loadMusic(1)).tracks.find((x) => x.id === t.Song.id)!;
    expect(mine).toMatchObject({ plays: 2, lastPlayed: 2000, favourite: true });
    const theirs = (await mdb.loadMusic(2)).tracks.find((x) => x.id === t.Song.id)!;
    expect(theirs).toMatchObject({ plays: 0, lastPlayed: null, favourite: false });
    await mdb.setFavourite(1, t.Song.id, false);
    expect((await mdb.loadMusic(1)).tracks.find((x) => x.id === t.Song.id)!.favourite).toBe(false);
  });
});

describe('playlists', () => {
  it('creates, renames, adds, reorders, removes and deletes', async () => {
    const t = await seed();
    const p = await mdb.createPlaylist(1, '  Road   Trip ', [t.Song.id, 12345]);
    expect(p.name).toBe('Road Trip');
    expect(p.trackIds).toEqual([t.Song.id]); // unknown songs are skipped
    await mdb.addToPlaylist(1, p.id, [t.Intro.id, t.Other.id, t.Intro.id]);
    let [list] = await mdb.listPlaylists(1);
    expect(list.trackIds).toEqual([t.Song.id, t.Intro.id, t.Other.id, t.Intro.id]); // duplicates allowed
    await mdb.setPlaylistTracks(1, p.id, [t.Other.id, t.Song.id]);
    await mdb.renamePlaylist(1, p.id, 'Drive');
    [list] = await mdb.listPlaylists(1);
    expect(list).toMatchObject({ name: 'Drive', trackIds: [t.Other.id, t.Song.id] });
    await mdb.addToPlaylist(1, p.id, [t.Intro.id]);
    [list] = await mdb.listPlaylists(1);
    expect(list.trackIds).toEqual([t.Other.id, t.Song.id, t.Intro.id]);
    await mdb.deletePlaylist(1, p.id);
    expect(await mdb.listPlaylists(1)).toEqual([]);
    const rows = await conn.select<unknown[]>('SELECT * FROM music_playlist_tracks');
    expect(rows).toEqual([]);
  });

  it('belong to one profile', async () => {
    await seed();
    const p = await mdb.createPlaylist(1, 'Mine');
    expect(await mdb.listPlaylists(2)).toEqual([]);
    await expect(mdb.renamePlaylist(2, p.id, 'Stolen')).rejects.toBeInstanceOf(mdb.PlaylistNotFound);
    await expect(mdb.deletePlaylist(2, p.id)).rejects.toBeInstanceOf(mdb.PlaylistNotFound);
    await expect(mdb.setPlaylistTracks(2, p.id, [])).rejects.toBeInstanceOf(mdb.PlaylistNotFound);
    expect((await mdb.listPlaylists(1))[0].name).toBe('Mine');
  });

  it('cleans names and ids', () => {
    expect(mdb.cleanPlaylistName('')).toBe('New Playlist');
    expect(mdb.cleanPlaylistName('x'.repeat(500))).toHaveLength(mdb.PLAYLIST_NAME_MAX);
    expect(mdb.cleanTrackIds([1, '2', 2.5, -3, 'x', null])).toEqual([1, 2]);
    expect(mdb.cleanTrackIds('nope')).toEqual([]);
  });

  it('orders playlists by last change', async () => {
    await seed();
    const a = await mdb.createPlaylist(1, 'A', [], 1000);
    const b = await mdb.createPlaylist(1, 'B', [], 2000);
    expect((await mdb.listPlaylists(1)).map((p) => p.id)).toEqual([b.id, a.id]);
    await mdb.renamePlaylist(1, a.id, 'A2', 3000);
    expect((await mdb.listPlaylists(1)).map((p) => p.id)).toEqual([a.id, b.id]);
  });
});
