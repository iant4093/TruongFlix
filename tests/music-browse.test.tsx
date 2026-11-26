import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import {
  albumFrom,
  artistsFrom,
  chartCountry,
  feedAlbums,
  feedSongAlbums,
  genresIn,
  inGenre,
  labelFrom,
  recentFrom,
  releaseFrom,
  sizedCover,
  uniqueAlbums,
  type CatalogAlbum,
} from '../src/services/musicCatalog';
import { useMusicDownloads } from '../src/services/musicDownloads';
import { useLibraryStore } from '../src/store/useLibraryStore';
import MusicAlbumDialog from '../src/components/browse/music/MusicAlbumDialog';
import MusicDownloadsDialog from '../src/components/browse/music/MusicDownloadsDialog';

const album = (id: string, extra: Partial<CatalogAlbum> = {}): CatalogAlbum => ({ id, title: `Album ${id}`, artist: `Artist ${id}`, artistId: `a${id}`, cover: null, year: 2026, type: 'Album', ...extra });

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useMusicDownloads.setState({ status: { state: 'offline', username: '', message: '' }, jobs: {} });
});
afterEach(() => cleanup());

it('reads the most-played charts in order, with square artwork, EPs told apart and genres kept', () => {
  const albums = feedAlbums({
    feed: {
      results: [
        { id: '1', name: 'Dandelion', artistName: 'Ella Langley', artistId: '9', artworkUrl100: 'https://is1-ssl.mzstatic.com/a/1.jpg/100x100bb.jpg', releaseDate: '2026-10-31', genres: [{ name: 'Country' }, { name: 'Music' }], contentAdvisoryRating: 'Explict' },
        { id: '2', name: 'PERFECT STORM - EP', artistName: 'TXT', artistId: '8', artworkUrl100: null, releaseDate: '2026-11-16', genres: [{ name: 'K-Pop' }] },
      ],
    },
  });
  expect(albums.map((a) => [a.id, a.title, a.type, a.explicit, a.genres])).toEqual([
    ['1', 'Dandelion', 'Album', true, ['Country']],
    ['2', 'PERFECT STORM', 'EP', false, ['K-Pop']],
  ]);
  expect(albums[0].cover).toBe('https://is1-ssl.mzstatic.com/a/1.jpg/600x600bb.jpg');
  expect(feedAlbums(null)).toEqual([]);
});

it('songs on the chart point to their albums', () => {
  expect(feedSongAlbums({ feed: { results: [{ url: 'https://music.apple.com/us/album/choosin-texas/1844932149?i=1844932150', genres: [{ name: 'Country' }] }, { url: 'nope' }] } })).toEqual([
    { id: '1844932149', genres: ['Country'] },
  ]);
});

it('artwork and artist photos are asked for at the size shown', () => {
  expect(sizedCover('https://is1-ssl.mzstatic.com/x.jpg/100x100bb.jpg', 400)).toBe('https://is1-ssl.mzstatic.com/x.jpg/400x400bb.jpg');
  // Artist photos are wide; a square crop of the middle.
  expect(sizedCover('https://is1-ssl.mzstatic.com/AMCArtistImages/x.png/1200x630cw.png', 300)).toBe('https://is1-ssl.mzstatic.com/AMCArtistImages/x.png/300x300cc.jpg');
  expect(sizedCover(null, 100)).toBeNull();
});

it('clean and explicit releases of the same album appear once, as the explicit one', () => {
  const list = uniqueAlbums([album('clean', { title: 'X', artist: 'Y' }), album('other'), album('explicit', { title: 'X', artist: 'Y', explicit: true })]);
  expect(list.map((a) => a.id)).toEqual(['explicit', 'other']);
});

it('genres show only when enough charting music fills them', () => {
  const pool = [
    ...Array.from({ length: 6 }, (_, i) => album(`h${i}`, { genres: ['Hip-Hop/Rap'] })),
    ...Array.from({ length: 2 }, (_, i) => album(`j${i}`, { genres: ['Jazz'] })),
    album('c', { genres: ['Contemporary Country'] }),
  ];
  expect(genresIn(pool).map((g) => g.key)).toEqual(['hiphop']);
  expect(inGenre(pool[8], 'country')).toBe(true);
});

it('new releases are charting albums and EPs from the last six weeks', () => {
  const today = new Date('2026-11-25T12:00:00Z');
  const recent = recentFrom([album('new', { released: '2026-11-20' }), album('old', { released: '2026-09-01' }), album('single', { released: '2026-11-21', type: 'Single' }), album('va', { released: '2026-11-22', artist: 'Various Artists' })], today);
  expect(recent.map((a) => a.id)).toEqual(['new']);
});

it('chart artists are named once, by their first credited artist', () => {
  const a = (artist: string, artistId: string | null = artist) => album(artist, { artist, artistId });
  expect(artistsFrom([a('Ella Langley'), a('Drake & 21 Savage', 'drake'), a('Various Artists'), a('ella langley'), a('No Id', null)]).map((x) => x.name)).toEqual(['Ella Langley', 'Drake']);
  expect(chartCountry('en-GB')).toBe('gb');
  expect(chartCountry('en')).toBe('us');
});

const LOOKUP = {
  results: [
    { wrapperType: 'collection', collectionId: 1097861387, collectionName: 'OK Computer', artistName: 'Radiohead', artistId: 657515, artworkUrl100: 'https://is1-ssl.mzstatic.com/ok.jpg/100x100bb.jpg', releaseDate: '1997-05-21T07:00:00Z', primaryGenreName: 'Alternative', copyright: '℗ 1997 XL Recordings Ltd', trackCount: 3, collectionExplicitness: 'notExplicit' },
    { wrapperType: 'track', kind: 'song', trackName: 'Paranoid Android', trackNumber: 2, discNumber: 1, trackTimeMillis: 387213, artistName: 'Radiohead' },
    { wrapperType: 'track', kind: 'song', trackName: 'Airbag', trackNumber: 1, discNumber: 1, trackTimeMillis: 287880, artistName: 'Radiohead' },
    { wrapperType: 'track', kind: 'song', trackName: 'Bonus', trackNumber: 1, discNumber: 2, trackTimeMillis: 100000, artistName: 'Radiohead feat. Guest' },
  ],
};

it('an album lookup gives its exact tracklist, in disc and track order', () => {
  const release = releaseFrom(LOOKUP);
  expect(release.id).toBe('itunes:1097861387');
  expect(release.tracks.map((t) => [t.disc, t.position, t.title, t.lengthMs])).toEqual([
    [1, 1, 'Airbag', 287880],
    [1, 2, 'Paranoid Android', 387213],
    [2, 1, 'Bonus', 100000],
  ]);
  expect(release.label).toBe('XL Recordings Ltd');
  expect(release.genres).toEqual(['Alternative']);
  expect(labelFrom('© 2016, 2017 Big Label')).toBe('Big Label');
  expect(albumFrom({ collectionId: 5, collectionName: 'Hit - Single', trackCount: 1 })?.type).toBe('Single');
  expect(() => releaseFrom({ results: [] })).toThrow();
});

it('Download sends this exact tracklist, then shows the progress', async () => {
  useLibraryStore.setState((s) => ({
    settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw', soulseek_quality: 'lossless' },
  }));
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'music_catalog') return LOOKUP;
    if (cmd === 'slsk_status') return { state: 'offline', username: '', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
    if (cmd === 'live_artwork') return 'C:/cache/cover.img';
    if (cmd === 'slsk_download_album') {
      const request = a.request as { id: string; releaseId: string; coverUrl: string; album: string; albumArtist: string; tracks: unknown[] };
      return { id: request.id, releaseId: request.releaseId, cover: request.coverUrl, album: request.album, artist: request.albumArtist, state: 'searching', message: '', bytes: 0, total: 0, filesDone: 0, filesTotal: request.tracks.length, source: null, path: null };
    }
    return undefined;
  });
  render(<MusicAlbumDialog album={{ id: '1097861387', title: 'OK Computer', artist: 'Radiohead', artistId: '657515', cover: null, year: 1997, type: 'Album' }} onClose={() => {}} onArtist={() => {}} />);
  expect(await screen.findByText('Paranoid Android')).toBeTruthy();
  // One release, one tracklist: no edition picker.
  expect(screen.queryByLabelText('Album edition')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
  await screen.findByText('Searching Soulseek…');

  const connect = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'slsk_connect')![1] as Record<string, unknown>;
  // Nothing is shared unless asked.
  expect(connect).toMatchObject({ username: 'me', password: 'pw', shared: [] });
  const request = (vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'slsk_download_album')![1] as { request: Record<string, unknown> }).request;
  expect(request).toMatchObject({
    releaseId: 'itunes:1097861387',
    album: 'OK Computer',
    albumArtist: 'Radiohead',
    quality: 'lossless',
    destination: 'C:/Music',
    coverPath: 'C:/cache/cover.img',
    genre: 'Alternative',
    date: '1997-05-21',
    tracks: [
      { title: 'Airbag', position: 1, disc: 1, lengthMs: 287880, artist: 'Radiohead' },
      { title: 'Paranoid Android', position: 2, disc: 1, lengthMs: 387213, artist: 'Radiohead' },
      { title: 'Bonus', position: 1, disc: 2, lengthMs: 100000, artist: 'Radiohead feat. Guest' },
    ],
  });
  // Store data never claims to be a MusicBrainz id.
  expect(request).not.toHaveProperty('releaseMbid');

  const id = String(request.id);
  act(() => {
    useMusicDownloads.setState((s) => ({
      jobs: { [id]: { ...s.jobs[id], state: 'downloading', bytes: 50, total: 100, filesDone: 1, source: { user: 'sharer', format: 'flac' } } },
    }));
  });
  expect(screen.getByText('Downloading 1/3')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
  expect(vi.mocked(invoke).mock.calls.some(([cmd, a]) => cmd === 'slsk_cancel' && (a as { id: string }).id === id)).toBe(true);
});

it('the Downloads panel opens while albums are downloading (it used to re-render forever)', () => {
  useMusicDownloads.setState({
    jobs: {
      j1: { id: 'j1', releaseId: 'itunes:1', cover: null, album: 'OK Computer', artist: 'Radiohead', state: 'downloading', message: '', bytes: 10, total: 100, filesDone: 1, filesTotal: 12, source: { user: 'sharer', format: 'flac' }, path: null },
      j2: { id: 'j2', releaseId: 'itunes:2', cover: null, album: 'Kid A', artist: 'Radiohead', state: 'done', message: '', bytes: 100, total: 100, filesDone: 10, filesTotal: 10, source: null, path: 'C:/Music/Radiohead/Kid A (2000)' },
    },
  });
  render(<MusicDownloadsDialog onClose={() => {}} />);
  expect(screen.getByText('OK Computer')).toBeTruthy();
  expect(screen.getByText('In your library')).toBeTruthy();
  act(() => useMusicDownloads.setState((s) => ({ jobs: { ...s.jobs, j1: { ...s.jobs.j1, bytes: 50 } } })));
  expect(screen.getByText(/50\.0 MB|0\.1 MB|MB of/)).toBeTruthy();
});

it('without an account, the album page points to Settings instead of downloading', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === 'music_catalog' ? LOOKUP : undefined));
  render(<MusicAlbumDialog album={{ id: '1097861387', title: 'OK Computer', artist: 'Radiohead', artistId: null, cover: null, year: 1997, type: 'Album' }} onClose={() => {}} onArtist={() => {}} />);
  expect(await screen.findByRole('button', { name: /Set up downloads/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Download$/ })).toBeNull();
});
