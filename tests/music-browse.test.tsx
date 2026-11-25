import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import {
  artistsFrom,
  baseTitle,
  chartCountry,
  chartFromFeed,
  pickEdition,
  recentFrom,
  releaseFrom,
  resolveAlbumId,
  type CatalogAlbum,
} from '../src/services/musicCatalog';
import { useMusicDownloads } from '../src/services/musicDownloads';
import { useLibraryStore } from '../src/store/useLibraryStore';
import MusicAlbumDialog from '../src/components/browse/music/MusicAlbumDialog';

const entry = (id: string, name: string, artist: string, date: string) => ({
  id: { label: `https://music.apple.com/us/album/x/${id}`, attributes: { 'im:id': id } },
  'im:name': { label: name },
  'im:artist': { label: artist },
  'im:image': [{ label: `https://is1.example/${id}.jpg/55x55bb.png` }, { label: `https://is1.example/${id}.jpg/170x170bb.png` }],
  'im:releaseDate': { label: `${date}T00:00:00-07:00` },
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useMusicDownloads.setState({ status: { state: 'offline', username: '', message: '' }, jobs: {}, covers: {} });
});
afterEach(() => cleanup());

it('reads the charts in order, with sharp square artwork and EPs told apart', () => {
  const albums = chartFromFeed({
    feed: {
      entry: [
        entry('1', 'Dandelion', 'Ella Langley', '2026-10-31'),
        entry('2', 'PERFECT STORM - EP', 'TOMORROW X TOGETHER', '2026-11-16'),
        entry('3', 'Dandelion', 'Ella Langley', '2026-10-31'),
      ],
    },
  });
  expect(albums.map((a) => [a.id, a.title, a.type, a.year])).toEqual([
    ['itunes:1', 'Dandelion', 'Album', 2026],
    ['itunes:2', 'PERFECT STORM', 'EP', 2026],
  ]);
  expect(albums[0].cover).toBe('https://is1.example/1.jpg/600x600bb.jpg');
  expect(chartFromFeed(null)).toEqual([]);
});

it('new releases are charting albums from the last six weeks, newest first', () => {
  const album = (id: string, released: string, extra: Partial<CatalogAlbum> = {}): CatalogAlbum => ({ id, title: id, artist: `Artist ${id}`, artistId: null, cover: null, year: 2026, type: 'Album', released, ...extra });
  const today = new Date('2026-11-25T12:00:00Z');
  const recent = recentFrom(
    [
      [album('old', '2026-09-01'), album('new', '2026-11-20'), album('single', '2026-11-21', { type: 'Single' })],
      [album('newer', '2026-11-24'), album('new', '2026-11-20'), album('va', '2026-11-22', { artist: 'Various Artists' })],
    ],
    today,
  );
  expect(recent.map((a) => a.id)).toEqual(['newer', 'new']);
});

it('chart artists are named once, by their first credited artist', () => {
  const a = (artist: string) => ({ id: artist, title: 'x', artist, artistId: null, cover: null, year: null, type: 'Album' }) as CatalogAlbum;
  expect(artistsFrom([a('Ella Langley'), a('for KING & COUNTRY & Angel'), a('Various Artists'), a('ella langley'), a("Cast of 'The Gilded Age'")]).map((x) => x.name)).toEqual([
    'Ella Langley',
    'for KING',
  ]);
});

it('edition noise is dropped before looking an album up', () => {
  expect(baseTitle('Meteora (Deluxe Edition)')).toBe('Meteora');
  expect(baseTitle('Abbey Road (Remastered)')).toBe('Abbey Road');
  expect(baseTitle('Their Greatest Hits 1971-1975')).toBe('Their Greatest Hits 1971-1975');
  expect(chartCountry('en-GB')).toBe('gb');
  expect(chartCountry('en')).toBe('us');
});

it('a chart album is matched to its MusicBrainz album, not the single of the same name', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    'release-groups': [
      { id: 'single', score: 100, title: 'Dandelion', 'primary-type': 'Single' },
      { id: 'album', score: 100, title: 'Dandelion', 'primary-type': 'Album' },
    ],
  });
  const id = await resolveAlbumId({ id: 'itunes:1', title: 'Dandelion (Deluxe Edition)', artist: 'Ella Langley', artistId: null, cover: null, year: 2026, type: 'Album' });
  expect(id).toBe('album');
  const url = String((vi.mocked(invoke).mock.calls[0][1] as { url: string }).url);
  expect(decodeURIComponent(url)).toContain('releasegroup:"Dandelion" AND artist:"Ella Langley"');
  // Already a MusicBrainz album: no lookup.
  expect(await resolveAlbumId({ id: 'mbid', title: 't', artist: 'a', artistId: null, cover: null, year: null, type: null })).toBe('mbid');
});

it('the edition downloaded has the usual tracklist, digital and worldwide first', () => {
  const r = (id: string, tracks: number, format: string, country: string, date = '2020-01-01') => ({ id, title: 'A', status: 'Official', date, country, tracks, format });
  expect(pickEdition([r('deluxe', 24, 'Digital Media', 'XW'), r('cd-us', 12, 'CD', 'US'), r('dig-xw', 12, 'Digital Media', 'XW'), r('vinyl', 12, '12" Vinyl', 'US')])?.id).toBe('dig-xw');
  expect(pickEdition([])).toBeNull();
});

const RELEASE = {
  id: 'rel',
  title: 'Test Album',
  date: '2024-03-01',
  'artist-credit': [{ name: 'Test Artist', joinphrase: '', artist: { id: 'artist-1', name: 'Test Artist' } }],
  'release-group': { id: 'rg', 'primary-type': 'Album', genres: [{ name: 'electronic', count: 3 }] },
  'cover-art-archive': { front: true },
  'label-info': [{ label: { name: 'Test Label' } }],
  media: [
    { position: 1, tracks: [{ id: 't1', position: 1, title: 'Alpha Song', length: 31000, recording: { id: 'r1' } }] },
    {
      position: 2,
      tracks: [{ id: 't2', position: 1, title: 'Beta Song', length: 47000, recording: { id: 'r2' }, 'artist-credit': [{ name: 'Guest', joinphrase: '' }] }],
    },
  ],
};

it('tracklists keep discs, guest artists and lengths', () => {
  const release = releaseFrom(RELEASE, []);
  expect(release.tracks.map((t) => [t.disc, t.position, t.title, t.artist, t.lengthMs])).toEqual([
    [1, 1, 'Alpha Song', 'Test Artist', 31000],
    [2, 1, 'Beta Song', 'Guest', 47000],
  ]);
  expect(release.genres).toEqual(['electronic']);
  expect(release.label).toBe('Test Label');
  expect(release.cover).toBe('https://coverartarchive.org/release/rel/front-500');
});

it('Download sends this exact tracklist, then shows the progress', async () => {
  useLibraryStore.setState((s) => ({
    settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw', soulseek_quality: 'lossless' },
  }));
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'music_catalog') {
      const url = String(a.url);
      if (url.includes('/release?release-group=')) return { releases: [{ id: 'rel', title: 'Test Album', status: 'Official', date: '2024-03-01', country: 'XW', media: [{ 'track-count': 2, format: 'Digital Media' }] }] };
      return RELEASE;
    }
    if (cmd === 'slsk_status') return { state: 'offline', username: '', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
    if (cmd === 'live_artwork') return 'C:/cache/cover.img';
    if (cmd === 'slsk_download_album') {
      const request = a.request as { id: string; releaseMbid: string; album: string; albumArtist: string; tracks: unknown[] };
      return { id: request.id, releaseMbid: request.releaseMbid, album: request.album, artist: request.albumArtist, state: 'searching', message: '', bytes: 0, total: 0, filesDone: 0, filesTotal: request.tracks.length, source: null, path: null };
    }
    return undefined;
  });
  render(<MusicAlbumDialog album={{ id: 'rg', title: 'Test Album', artist: 'Test Artist', artistId: 'artist-1', cover: null, year: 2024, type: 'Album' }} onClose={() => {}} onArtist={() => {}} />);
  expect(await screen.findByText('Beta Song')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
  await screen.findByText('Searching Soulseek…');

  const connect = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'slsk_connect')![1] as Record<string, unknown>;
  // Nothing is shared unless asked.
  expect(connect).toMatchObject({ username: 'me', password: 'pw', shared: [] });
  const request = (vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'slsk_download_album')![1] as { request: Record<string, unknown> }).request;
  expect(request).toMatchObject({
    releaseMbid: 'rel',
    album: 'Test Album',
    albumArtist: 'Test Artist',
    quality: 'lossless',
    destination: 'C:/Music',
    coverPath: 'C:/cache/cover.img',
    genre: 'Electronic',
    tracks: [
      { title: 'Alpha Song', position: 1, disc: 1, lengthMs: 31000, artist: 'Test Artist', recordingMbid: 'r1', trackMbid: 't1' },
      { title: 'Beta Song', position: 1, disc: 2, lengthMs: 47000, artist: 'Guest', recordingMbid: 'r2', trackMbid: 't2' },
    ],
  });

  const id = String(request.id);
  act(() => {
    useMusicDownloads.setState((s) => ({
      jobs: { [id]: { ...s.jobs[id], state: 'downloading', bytes: 50, total: 100, filesDone: 1, source: { user: 'sharer', format: 'flac' } } },
    }));
  });
  expect(screen.getByText('Downloading 1/2')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
  expect(vi.mocked(invoke).mock.calls.some(([cmd, a]) => cmd === 'slsk_cancel' && (a as { id: string }).id === id)).toBe(true);
});

it('without an account, the album page points to Settings instead of downloading', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd !== 'music_catalog') return undefined;
    return String((args as { url: string }).url).includes('/release?release-group=')
      ? { releases: [{ id: 'rel', title: 'Test Album', status: 'Official', media: [{ 'track-count': 2 }] }] }
      : RELEASE;
  });
  render(<MusicAlbumDialog album={{ id: 'rg2', title: 'Test Album', artist: 'Test Artist', artistId: null, cover: null, year: 2024, type: 'Album' }} onClose={() => {}} onArtist={() => {}} />);
  expect(await screen.findByRole('button', { name: /Set up downloads/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Download$/ })).toBeNull();
});
