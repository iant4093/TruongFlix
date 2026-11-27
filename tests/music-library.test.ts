import { describe, expect, it, vi } from 'vitest';
import { assembleLibrary, formatTime, isPinned, listenNow, searchMusic } from '../src/music/library';
import type { MusicTrack } from '../src/music/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

const track = (id: number, patch: Partial<MusicTrack>): MusicTrack => ({
  id,
  title: `Song ${id}`,
  artist: 'Luma Vale',
  artistId: 1,
  album: 'Neon',
  albumId: 1,
  albumArtist: 'Luma Vale',
  albumArtistId: 1,
  trackNo: id,
  discNo: 1,
  year: 2023,
  genre: 'Pop',
  duration: 100,
  codec: 'mp3',
  art: null,
  favourite: false,
  plays: 0,
  lastPlayed: null,
  addedAt: 1000,
  hasLyrics: false,
  ...patch,
});

const tracks = [
  track(2, { trackNo: 2, title: 'Béla' }),
  track(1, { trackNo: 1, title: 'Afterglow', art: 'cover1', plays: 3, lastPlayed: 50 }),
  track(3, { album: 'Echo', albumId: 2, trackNo: 1, discNo: 2, addedAt: 5000, art: 'cover2' }),
  track(4, { album: 'Night Bus', albumId: 3, albumArtist: 'Various Artists', albumArtistId: 9, artist: 'Kei', artistId: 5, title: 'Last Stop', plays: 1, lastPlayed: 90 }),
];

describe('music library', () => {
  it('builds albums (in disc/track order) and artists from songs', () => {
    const lib = assembleLibrary(tracks, []);
    expect(lib.albums.map((a) => a.title)).toEqual(['Echo', 'Neon', 'Night Bus']);
    const neon = lib.albums.find((a) => a.id === 1)!;
    expect(neon.trackIds).toEqual([1, 2]);
    expect(neon).toMatchObject({ art: 'cover1', duration: 200, plays: 3, lastPlayed: 50 });
    const luma = lib.artists.find((a) => a.id === 1)!;
    expect(luma.albumIds.sort()).toEqual([1, 2]);
    expect(luma.trackCount).toBe(3);
    // A guest on a compilation is an artist with songs but no albums.
    expect(lib.artists.find((a) => a.id === 5)).toMatchObject({ name: 'Kei', albumIds: [], trackCount: 1 });
    expect(lib.artists.find((a) => a.id === 9)!.albumIds).toEqual([3]);
  });

  it('picks Listen Now shelves', () => {
    const ln = listenNow(assembleLibrary(tracks, []));
    expect(ln.recent.map((a) => a.title)).toEqual(['Night Bus', 'Neon']);
    expect(ln.top.map((a) => a.title)).toEqual(['Neon', 'Night Bus']);
    expect(ln.added[0].title).toBe('Echo');
    expect(ln.topSongs.map((t) => t.id)).toEqual([1, 4]);
  });

  it('shows pinned albums and playlists in the order they were pinned, leaving out gone ones', () => {
    const playlists = [
      { id: 7, name: 'Old Mix', trackIds: [1], updatedAt: 100 },
      { id: 8, name: 'New Mix', trackIds: [3, 4], updatedAt: 900 },
    ];
    const lib = assembleLibrary(tracks, playlists, [
      { kind: 'playlist', id: 7 },
      { kind: 'album', id: 3 },
      { kind: 'album', id: 99 }, // album no longer in the library
      { kind: 'playlist', id: 42 }, // deleted playlist
      { kind: 'album', id: 1 },
    ]);
    const ln = listenNow(lib);
    expect(ln.pinned.map((p) => (p.kind === 'album' ? `album:${p.album.title}` : `playlist:${p.playlist.name}`))).toEqual(['playlist:Old Mix', 'album:Night Bus', 'album:Neon']);
    // The Playlists row: most recently changed first.
    expect(ln.playlists.map((p) => p.name)).toEqual(['New Mix', 'Old Mix']);
    expect(isPinned(lib, 'album', 3)).toBe(true);
    expect(isPinned(lib, 'playlist', 8)).toBe(false);
  });

  it('has no Pinned or Playlists rows when nothing is pinned and there are no playlists', () => {
    const ln = listenNow(assembleLibrary(tracks, []));
    expect(ln.pinned).toEqual([]);
    expect(ln.playlists).toEqual([]);
    // Libraries from before pins existed have none.
    const { pins: _, ...old } = assembleLibrary(tracks, []);
    expect(listenNow(old).pinned).toEqual([]);
    expect(isPinned(old, 'album', 1)).toBe(false);
  });

  it('searches titles, artists and albums, ignoring accents and case', () => {
    const lib = assembleLibrary(tracks, []);
    expect(searchMusic(lib, 'bela').tracks.map((t) => t.id)).toEqual([2]);
    expect(searchMusic(lib, 'kei stop').tracks.map((t) => t.id)).toEqual([4]);
    expect(searchMusic(lib, 'NIGHT').albums.map((a) => a.id)).toEqual([3]);
    expect(searchMusic(lib, 'luma').artists.map((a) => a.id)).toEqual([1]);
    expect(searchMusic(lib, '   ').tracks).toEqual([]);
  });

  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.4)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(NaN)).toBe('0:00');
  });
});

describe('music scan', () => {
  it('drops files that vanished or whose folder was removed, but not offline ones', async () => {
    const { goneMusicPaths } = await import('../src/services/music');
    const indexed = ['D:\\Music\\a.mp3', 'D:\\Music\\b.mp3', 'E:\\Old\\c.mp3', '/nas/x/d.flac'];
    const gone = goneMusicPaths(indexed, new Set(['D:\\Music\\a.mp3']), ['D:\\Music', '/nas/x'], ['/nas/x']);
    expect(gone).toEqual(['D:\\Music\\b.mp3', 'E:\\Old\\c.mp3']);
  });

  it('keeps songs in folders that could not be read, and when a folder suddenly lost most songs', async () => {
    const { goneMusicPaths } = await import('../src/services/music');
    const album = Array.from({ length: 30 }, (_, i) => `D:\\Music\\Album\\${i}.flac`);
    // A share dropping out mid-scan: the album folder couldn't be read, so nothing in it goes.
    expect(goneMusicPaths(album, new Set(), ['D:\\Music'], [], ['D:\\Music\\Album'])).toEqual([]);
    // Every song "gone" at once from a folder of 30: left for the next scan.
    expect(goneMusicPaths(album, new Set(), ['D:\\Music'], [])).toEqual([]);
    // A few really deleted: those go.
    expect(goneMusicPaths(album, new Set(album.slice(3)), ['D:\\Music'], [])).toEqual(album.slice(0, 3));
    // Most of them deleted (but not all): they go too.
    expect(goneMusicPaths(album, new Set(album.slice(25)), ['D:\\Music'], [])).toEqual(album.slice(0, 25));
    // A full rescan the user asked for removes them even when every one is gone.
    expect(goneMusicPaths(album, new Set(), ['D:\\Music'], [], [], true)).toEqual(album);
  });
});
