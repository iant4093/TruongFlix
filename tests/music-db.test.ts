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
    expect(index.get('/m/A/01 Intro.mp3')).toMatchObject({ id: t.Intro.id, mtime: 2 });
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

  it('imports a big batch in several statements, every song once', async () => {
    const many = Array.from({ length: 95 }, (_, i) => file(`/m/Big/${String(i).padStart(2, '0')} Song.mp3`, { title: `Song ${i}`, artist: 'Band', album: 'Big' }));
    await mdb.upsertMusicFiles(many);
    await mdb.upsertMusicFiles(many.slice(0, 50).map((f) => ({ ...f, mtime: 3, title: `${f.title} (v2)` })));
    const index = await mdb.musicFileIndex();
    expect([...index.keys()].filter((p) => p.startsWith('/m/Big/'))).toHaveLength(95);
    expect(index.get('/m/Big/00 Song.mp3')?.mtime).toBe(3);
    expect(index.get('/m/Big/94 Song.mp3')?.mtime).toBe(1);
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

describe('pins', () => {
  it('saves pinned albums and playlists per profile, in the order they were pinned', async () => {
    const t = await seed();
    const mix = await mdb.createPlaylist(1, 'Mix', [t.Intro.id]);
    expect(await mdb.setPinned(1, 'playlist', mix.id, true, 1000)).toBe(true);
    expect(await mdb.setPinned(1, 'album', t.Other.albumId, true, 2000)).toBe(true);
    expect(await mdb.setPinned(1, 'album', t.Intro.albumId, true, 3000)).toBe(true);
    // Pinning again keeps its place.
    expect(await mdb.setPinned(1, 'playlist', mix.id, true, 4000)).toBe(true);
    expect(await mdb.listPins(1)).toEqual([
      { kind: 'playlist', id: mix.id },
      { kind: 'album', id: t.Other.albumId },
      { kind: 'album', id: t.Intro.albumId },
    ]);
    expect((await mdb.loadMusic(1)).pins).toHaveLength(3);
    // Another profile has its own pins, and can't pin someone else's playlist.
    expect(await mdb.listPins(2)).toEqual([]);
    expect((await mdb.loadMusic(2)).pins).toEqual([]);
    expect(await mdb.setPinned(2, 'playlist', mix.id, true)).toBe(false);
    expect(await mdb.setPinned(2, 'album', 9999, true)).toBe(false);
    expect(await mdb.listPins(2)).toEqual([]);
    // Unpinning.
    await mdb.setPinned(1, 'album', t.Other.albumId, false);
    expect((await mdb.listPins(1)).map((p) => p.kind)).toEqual(['playlist', 'album']);
  });

  it('survive a restart (stored in the database)', async () => {
    const t = await seed();
    await mdb.setPinned(1, 'album', t.Intro.albumId, true);
    vi.resetModules();
    mdb = await import('../src/services/musicdb');
    expect((await mdb.loadMusic(1)).pins).toEqual([{ kind: 'album', id: t.Intro.albumId }]);
  });

  it('go with a deleted playlist or an album that left the library', async () => {
    const t = await seed();
    const mix = await mdb.createPlaylist(1, 'Mix');
    await mdb.setPinned(1, 'playlist', mix.id, true);
    await mdb.setPinned(1, 'album', t.Other.albumId, true);
    await mdb.deletePlaylist(1, mix.id);
    await mdb.removeMusicPaths(['/m/B/x.flac']);
    expect(await mdb.listPins(1)).toEqual([]);
    expect(await conn.select<unknown[]>('SELECT * FROM music_pins')).toEqual([]);
  });
});

describe('plays for Wrapped', () => {
  it('lists a profile’s plays with their songs, oldest first', async () => {
    const t = await seed();
    await mdb.recordPlay(1, t.Song.id, 2000);
    await mdb.recordPlay(1, t.Intro.id, 1000);
    await mdb.recordPlay(2, t.Other.id, 1500);
    const plays = await mdb.listMusicPlays(1);
    expect(plays.map((p) => [p.title, p.playedAt])).toEqual([['Intro', 1000], ['Song', 2000]]);
    expect(plays[1]).toMatchObject({ artist: 'Guest', album: 'Neon', albumArtist: 'Luma', duration: 200, seconds: null });
    expect(await mdb.listMusicPlays(3)).toEqual([]);
  });

  it('stores how long the latest play was listened to, once, capped at the song’s length', async () => {
    const t = await seed();
    const now = 10_000_000;
    await mdb.recordPlay(1, t.Song.id, now - 60_000);
    await mdb.recordPlay(1, t.Song.id, now - 30_000);
    expect(await mdb.setPlaySeconds(1, t.Song.id, 150.26, now)).toBe(true);
    // A second report finds the earlier play; a third has nothing left to fill.
    expect(await mdb.setPlaySeconds(1, t.Song.id, 999, now)).toBe(true);
    expect(await mdb.setPlaySeconds(1, t.Song.id, 50, now)).toBe(false);
    expect((await mdb.listMusicPlays(1)).map((p) => p.seconds)).toEqual([200, 150.3]);
  });

  it('ignores reports for other profiles, old plays and bad values', async () => {
    const t = await seed();
    const now = 100_000_000;
    await mdb.recordPlay(1, t.Song.id, now - 3 * 3600_000);
    expect(await mdb.setPlaySeconds(2, t.Song.id, 100, now)).toBe(false);
    expect(await mdb.setPlaySeconds(1, t.Song.id, 100, now)).toBe(false); // counted hours ago
    expect(await mdb.setPlaySeconds(1, t.Song.id, Number.NaN, now)).toBe(false);
    expect(await mdb.setPlaySeconds(1, 4242, 100, now)).toBe(false);
    expect((await mdb.listMusicPlays(1))[0].seconds).toBeNull();
  });

  it('adds the seconds column to a plays table made before it existed', async () => {
    conn.raw.exec('CREATE TABLE music_plays (profile_id INTEGER NOT NULL, track_id INTEGER NOT NULL, played_at INTEGER NOT NULL)');
    conn.raw.exec('INSERT INTO music_plays VALUES (1, 1, 5)');
    await mdb.musicDb();
    const cols = (conn.raw.prepare('PRAGMA table_info(music_plays)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['profile_id', 'track_id', 'played_at', 'seconds']);
  });
});

describe('playlist descriptions and covers', () => {
  it('adds the columns to a playlists table made before they existed; its playlists still load', async () => {
    conn.raw.exec(`CREATE TABLE music_playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO music_playlists (profile_id, name, created_at, updated_at) VALUES (1, 'Old Mix', 1, 5);`);
    const t = await seed();
    await mdb.setPlaylistTracks(1, 1, [t.Song.id, t.Intro.id]);
    const cols = (conn.raw.prepare('PRAGMA table_info(music_playlists)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'profile_id', 'name', 'created_at', 'updated_at', 'description', 'cover', 'import_cover', 'import_cover_url']);
    expect((await mdb.loadMusic(1)).playlists).toEqual([expect.objectContaining({ id: 1, name: 'Old Mix', trackIds: [t.Song.id, t.Intro.id], description: '', cover: null, customCover: false })]);
  });

  it('keeps a short one-paragraph description, or none', async () => {
    const p = await mdb.createPlaylist(1, 'Mix', [], 10);
    expect(await mdb.setPlaylistDescription(1, p.id, '  Late night\n\n drives  ', 20)).toBe('Late night drives');
    expect(await mdb.setPlaylistDescription(1, p.id, 'x'.repeat(500), 30)).toHaveLength(mdb.PLAYLIST_DESCRIPTION_MAX);
    expect(await mdb.setPlaylistDescription(1, p.id, '   ', 40)).toBe('');
    expect((await mdb.listPlaylists(1))[0]).toMatchObject({ description: '', updatedAt: 40 });
    await expect(mdb.setPlaylistDescription(2, p.id, 'Not mine')).rejects.toBeInstanceOf(mdb.PlaylistNotFound);
  });

  it('shows the user’s own cover over the imported artwork, and the artwork again once theirs is taken off', async () => {
    const p = await mdb.createPlaylist(1, 'Mix', [], 10);
    const imported = `${'a'.repeat(32)}.jpg`;
    const mine = `${'b'.repeat(32)}.png`;
    expect(await mdb.playlistImportCoverUrl(1, p.id)).toBeNull();
    expect(await mdb.setPlaylistImportCover(1, p.id, imported, 'https://i.scdn.co/image/a')).toEqual({ cover: imported, customCover: false });
    expect(await mdb.playlistImportCoverUrl(1, p.id)).toBe('https://i.scdn.co/image/a');
    // Saving artwork from an import doesn't move the playlist to the top.
    expect((await mdb.listPlaylists(1))[0].updatedAt).toBe(10);
    expect(await mdb.setPlaylistCover(1, p.id, mine)).toEqual({ cover: mine, customCover: true });
    expect(await mdb.setPlaylistImportCover(1, p.id, `${'c'.repeat(32)}.jpg`, 'https://i.scdn.co/image/c')).toEqual({ cover: mine, customCover: true });
    expect(await mdb.setPlaylistCover(1, p.id, null)).toEqual({ cover: `${'c'.repeat(32)}.jpg`, customCover: false });
    await expect(mdb.setPlaylistCover(1, p.id, '../../secrets.txt')).rejects.toThrow('Bad cover');
    await expect(mdb.setPlaylistCover(2, p.id, mine)).rejects.toBeInstanceOf(mdb.PlaylistNotFound);
    const plain = await mdb.createPlaylist(1, 'Plain');
    expect(await mdb.setPlaylistCover(1, plain.id, null)).toEqual({ cover: null, customCover: false });
  });
});
