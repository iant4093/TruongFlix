import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));
const events = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name)!.add(cb);
    return () => events.get(name)?.delete(cb);
  },
}));
const scan = vi.hoisted(() => ({ files: new Map<string, { id: number; mtime: number; size: number }>() }));
vi.mock('../src/services/music', async () => {
  const { create } = await import('zustand');
  return { runMusicScan: vi.fn(async () => {}), songFileGone: vi.fn(async () => false), useMusicScan: create(() => ({ running: false })) };
});
vi.mock('../src/services/musicdb', () => ({ musicFileIndex: async () => scan.files }));
vi.mock('../src/music/actions', () => ({
  createPlaylist: vi.fn(async (name: string, trackIds: number[]) => ({ id: 77, name, trackIds, updatedAt: 0 })),
  setPlaylistTracks: vi.fn(async () => {}),
  importPlaylistCover: vi.fn(async () => {}),
}));

import { createPlaylist, importPlaylistCover, setPlaylistTracks } from '../src/music/actions';
import { useMusicPlayer } from '../src/music/player';
import type { MusicTrack } from '../src/music/types';
import { useMusicDownloads } from '../src/services/musicDownloads';
import {
  addImport,
  coreTitle,
  inLibrary,
  parseSongList,
  pickStoreSong,
  songArtists,
  songFromVideo,
  splitArtists,
  startImport,
  stopImport,
  usePlaylistImports,
  setImportQuality,
  importQuality,
  type ImportSong,
} from '../src/services/playlistImport';
import { useLibraryStore } from '../src/store/useLibraryStore';

const emit = (name: string, payload: unknown) => events.get(name)?.forEach((cb) => cb({ payload }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(createPlaylist).mockClear();
  vi.mocked(setPlaylistTracks).mockClear();
  vi.mocked(importPlaylistCover).mockReset();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useMusicDownloads.setState({ status: { state: 'offline', username: '', message: '' }, jobs: {} });
  usePlaylistImports.setState({ imports: {}, order: [] });
  scan.files = new Map();
});

it('reads pasted songs: an exported CSV, or one "Artist - Title" per line', () => {
  const csv = 'Track URI,Track Name,Artist Name(s),Album Name,Duration (ms)\nspotify:track:1,"Mo Money Mo Problems (feat. Puff Daddy & Mase)","The Notorious B.I.G., Puff Daddy",Life After Death,257000\nspotify:track:2,Hey Ya!,Outkast,Speakerboxxx,235213';
  expect(parseSongList(csv)).toEqual([
    { title: 'Mo Money Mo Problems (feat. Puff Daddy & Mase)', artists: ['The Notorious B.I.G.', 'Puff Daddy'], album: 'Life After Death', lengthMs: 257000, appleId: null, cover: null, explicit: false },
    { title: 'Hey Ya!', artists: ['Outkast'], album: 'Speakerboxxx', lengthMs: 235213, appleId: null, cover: null, explicit: false },
  ]);
  const lines = parseSongList('1. Radiohead - Paranoid Android\nDaft Punk – One More Time\n\nJust A Title');
  expect(lines.map((s) => [s.artists, s.title])).toEqual([
    [['Radiohead'], 'Paranoid Android'],
    [['Daft Punk'], 'One More Time'],
    [[], 'Just A Title'],
  ]);
});

it('works out the song in a music video title', () => {
  expect(songFromVideo('BELLAKEO (Video Oficial) - Peso Pluma, Anitta', 'PesoPluma')).toEqual({ title: 'BELLAKEO', artists: ['Peso Pluma', 'Anitta'] });
  expect(songFromVideo('Taylor Swift - Anti-Hero (Official Music Video)', 'TaylorSwift')).toEqual({ title: 'Anti-Hero', artists: ['Taylor Swift'] });
  expect(songFromVideo('Becky G - POR EL CONTRARIO (Performance Video) ft. Ángela Aguilar, Leonardo Aguilar', 'Becky G')).toEqual({ title: 'POR EL CONTRARIO', artists: ['Becky G', 'Ángela Aguilar', 'Leonardo Aguilar'] });
  // No "Artist - Title": the channel is the artist.
  expect(songFromVideo('Blinding Lights [Lyrics]', 'The Weeknd')).toEqual({ title: 'Blinding Lights', artists: ['The Weeknd'] });
});

it('titles and credits are compared by their own words', () => {
  expect(coreTitle('Mo Money Mo Problems (feat. Puff Daddy & Mase) - 2014 Remaster')).toBe('mo money mo problems');
  expect(coreTitle('Flower In A Hurricane [From GTAVI: Original Score]')).toBe('flower in a hurricane');
  expect(splitArtists('KAROL G, Judeline & rusowsky')).toEqual(['KAROL G', 'Judeline', 'rusowsky']);
  expect(songArtists({ artists: ['Karol G', 'Judeline'], store: { artist: 'KAROL G, Judeline & rusowsky' } as ImportSong['store'] })).toEqual(['KAROL G', 'Judeline', 'rusowsky']);
});

const row = (trackName: string, artistName: string, trackTimeMillis: number, extra: Record<string, unknown> = {}) => ({
  wrapperType: 'track',
  kind: 'song',
  trackId: 1,
  trackName,
  artistName,
  collectionName: `${trackName} - Single`,
  trackTimeMillis,
  trackNumber: 1,
  discNumber: 1,
  releaseDate: '2025-10-01T07:00:00Z',
  primaryGenreName: 'Pop',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/x.jpg/100x100bb.jpg',
  ...extra,
});

it('matches each song to the store by title, artist and length', () => {
  const song = { title: 'Housewife', artists: ['Tate McRae'], lengthMs: 208810, lengthTrusted: true, explicit: false };
  const found = pickStoreSong(song, [row('Housewife', 'Karaoke Kings', 208000), row('Housewife (Sped Up)', 'Tate McRae', 150000), row('Housewife', 'Tate McRae', 208810)]);
  expect(found).toMatchObject({ title: 'Housewife', artist: 'Tate McRae', album: 'Housewife', track: 1, date: '2025-10-01', cover: 'https://is1-ssl.mzstatic.com/x.jpg/600x600bb.jpg' });
  // Another recording's length is never it.
  expect(pickStoreSong(song, [row('Housewife', 'Tate McRae', 260000)])).toBeNull();
  // A music video runs longer than the song: its length is only a hint.
  expect(pickStoreSong({ ...song, lengthMs: 240000, lengthTrusted: false }, [row('Housewife', 'Tate McRae', 208810)])).not.toBeNull();
});

it('songs already in the library are recognised', () => {
  const track = { id: 5, title: 'Paranoid Android', artist: 'Radiohead', albumArtist: 'Radiohead' } as MusicTrack;
  expect(inLibrary({ title: 'Paranoid Android - Remastered', artists: ['Radiohead'] }, null, [track])?.id).toBe(5);
  expect(inLibrary({ title: 'Paranoid Android', artists: ['Someone Else'] }, null, [track])).toBeNull();
});

it('an import skips songs you have, downloads the rest one by one, and makes the playlist in Music', async () => {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw' } }));
  useMusicPlayer.setState({
    api: {} as never,
    library: { tracks: [{ id: 5, title: 'Paranoid Android', artist: 'Radiohead', albumArtist: 'Radiohead' } as MusicTrack], albums: [], artists: [], playlists: [] },
  });
  const requests: Record<string, unknown>[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'slsk_status') return { state: 'online', username: 'me', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
    if (cmd === 'live_artwork') return 'C:/cache/cover.img';
    if (cmd === 'music_catalog') return String(a.url).includes('Housewife') ? { results: [row('Housewife', 'Tate McRae', 208810)] } : { results: [] };
    if (cmd === 'slsk_download_song') {
      const request = a.request as Record<string, unknown>;
      requests.push(request);
      return { id: request.id, kind: 'song', group: request.group, releaseId: 'x', album: request.title, artist: request.artist, cover: null, state: 'searching', message: '', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null };
    }
    return undefined;
  });
  const id = addImport(
    {
      source: 'spotify',
      id: 'p',
      name: 'Mix',
      owner: null,
      cover: null,
      total: null,
      songs: [
        { title: 'Housewife', artists: ['Tate McRae'], album: null, lengthMs: 208810, appleId: null, cover: null, explicit: false },
        { title: 'Paranoid Android', artists: ['Radiohead'], album: null, lengthMs: 387000, appleId: null, cover: null, explicit: false },
        { title: 'Nowhere To Be Found', artists: ['Nobody'], album: null, lengthMs: 200000, appleId: null, cover: null, explicit: false },
      ],
    },
    'lossless',
  );
  await startImport(id);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  const songs = () => usePlaylistImports.getState().imports[id].songs;
  expect(songs()[1].state).toBe('owned');
  // Tagged and searched with the store's details.
  // Songs start side by side, so they're told apart by title.
  const housewife = requests.findIndex((r) => r.title === 'Housewife');
  const nowhere = 1 - housewife;
  expect(requests[housewife]).toMatchObject({ group: id, title: 'Housewife', artists: ['Tate McRae'], album: 'Housewife', lengthMs: 208810, track: 1, date: '2025-10-01', quality: 'lossless', destination: 'C:/Music', coverPath: 'C:/cache/cover.img' });
  expect(requests[nowhere]).toMatchObject({ title: 'Nowhere To Be Found', album: null, track: null });

  const job = (n: number, patch: Record<string, unknown>) => ({ id: requests[n].id, kind: 'song', group: id, releaseId: 'x', album: 'x', artist: 'x', cover: null, message: '', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null, ...patch });
  emit('slsk-job', job(nowhere, { state: 'failed', code: 'no-match', message: 'Nobody on Soulseek is sharing this song right now.' }));
  expect(songs()[2]).toMatchObject({ state: 'failed', message: 'Nobody on Soulseek is sharing this song right now.' });
  scan.files = new Map([['C:\\Music\\Tate McRae\\Housewife (2025)\\01 - Housewife.flac', { id: 9, mtime: 0, size: 1 }]]);
  emit('slsk-job', job(housewife, { state: 'done', path: 'C:/Music/Tate McRae/Housewife (2025)/01 - Housewife.flac' }));
  expect(songs()[0].state).toBe('done');
  // Downloaded and already-owned songs, in the playlist's order.
  await vi.waitFor(() => expect(createPlaylist).toHaveBeenCalledWith('Mix', [9, 5]));
  await vi.waitFor(() => expect(usePlaylistImports.getState().imports[id].playlistId).toBe(77));
  // Each song isn't announced on its own.
  expect(useLibraryStore.getState().toasts.map((t) => t.message)).toEqual(['Mix is in your music library (1 song not found)']);
});

it('songs copied out of the Spotify app are read one by one, in order', async () => {
  const { readPlaylist, spotifySongIds } = await import('../src/services/playlistImport');
  const pasted = 'https://open.spotify.com/track/4HCOHRCSQelz2GPX8iTamO\nhttps://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=x\nspotify:track:0VjIjW4GlUZAMYd2vXMi3c';
  expect(spotifySongIds(pasted)).toEqual(['4HCOHRCSQelz2GPX8iTamO', '0VjIjW4GlUZAMYd2vXMi3b', '0VjIjW4GlUZAMYd2vXMi3c']);
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd !== 'music_spotify_songs') return undefined;
    const ids = (args as { ids: string[] }).ids;
    // One song's page couldn't be read.
    return ids.map((id, i) => (i === 2 ? null : { title: `Song ${id.slice(-1)}`, artists: ['Artist'], lengthMs: 200000, explicit: false }));
  });
  const progress: number[] = [];
  const read = await readPlaylist(pasted, (done) => progress.push(done));
  expect(read.songs.map((s) => s.title)).toEqual(['Song O', 'Song b']);
  expect(read).toMatchObject({ source: 'spotify', total: 3, owner: '1 couldn’t be read' });
  expect(progress).toEqual([3]);
});

it('a song Soulseek didn’t answer for is searched again a little later, once', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw' } }));
    useMusicPlayer.setState({ api: {} as never, library: { tracks: [], albums: [], artists: [], playlists: [] } });
    const requests: Record<string, unknown>[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === 'slsk_status' || cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
      if (cmd === 'slsk_jobs') return [];
      if (cmd === 'music_catalog') return { results: [] };
      if (cmd === 'slsk_download_song') {
        const request = a.request as Record<string, unknown>;
        requests.push(request);
        return { id: request.id, kind: 'song', group: request.group, releaseId: 'x', album: 'x', artist: 'x', cover: null, state: 'searching', message: '', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null };
      }
      return undefined;
    });
    const id = addImport({ source: 'list', id: 'l', name: 'L', owner: null, cover: null, total: null, songs: [{ title: 'Timeless', artists: ['The Weeknd'], album: null, lengthMs: null, appleId: null, cover: null, explicit: false }] }, 'any');
    await startImport(id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const fail = (n: number) => emit('slsk-job', { id: requests[n].id, kind: 'song', group: id, releaseId: 'x', album: 'x', artist: 'x', cover: null, state: 'failed', code: 'no-answer', message: 'Nobody answered on Soulseek', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null });
    fail(0);
    expect(usePlaylistImports.getState().imports[id].songs[0].state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(21_000);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    // The second time, it stays not found.
    fail(1);
    expect(usePlaylistImports.getState().imports[id].songs[0]).toMatchObject({ state: 'failed', message: 'Nobody answered on Soulseek' });
  } finally {
    vi.useRealTimers();
  }
});

it('when the connection to Soulseek drops, songs wait for it and carry on, instead of failing', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw' } }));
    useMusicPlayer.setState({ api: {} as never, library: { tracks: [], albums: [], artists: [], playlists: [] } });
    const requests: Record<string, unknown>[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === 'slsk_status' || cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
      if (cmd === 'slsk_jobs') return [];
      if (cmd === 'music_catalog') return { results: [] };
      if (cmd === 'slsk_download_song') {
        const request = a.request as Record<string, unknown>;
        requests.push(request);
        return { id: request.id, kind: 'song', group: request.group, releaseId: 'x', album: 'x', artist: 'x', cover: null, state: 'searching', message: '', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null };
      }
      return undefined;
    });
    const id = addImport({ source: 'list', id: 'l', name: 'L', owner: null, cover: null, total: null, songs: [{ title: 'Moonlight', artists: ['Kali Uchis'], album: null, lengthMs: null, appleId: null, cover: null, explicit: false }] }, 'any');
    await startImport(id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // The server drops the connection mid-song; the app is reconnecting.
    useMusicDownloads.setState({ status: { state: 'connecting', username: 'me', message: 'Reconnecting…' } });
    emit('slsk-job', { id: requests[0].id, kind: 'song', group: id, releaseId: 'x', album: 'x', artist: 'x', cover: null, state: 'failed', code: 'connection', message: 'The connection to Soulseek dropped', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null });
    const song = () => usePlaylistImports.getState().imports[id].songs[0];
    expect(song()).toMatchObject({ state: 'waiting', message: '' });
    await vi.advanceTimersByTimeAsync(10_000);
    // Nothing starts while it's reconnecting…
    expect(requests).toHaveLength(1);
    // …and the song starts again once it's back.
    emit('slsk-status', { state: 'online', username: 'me', message: '' });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(song().state).toBe('searching');
  } finally {
    vi.useRealTimers();
  }
});

it('a song whose copies were all busy is tried again a minute later', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw' } }));
    useMusicPlayer.setState({ api: {} as never, library: { tracks: [], albums: [], artists: [], playlists: [] } });
    const requests: Record<string, unknown>[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === 'slsk_status' || cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
      if (cmd === 'slsk_jobs') return [];
      if (cmd === 'music_catalog') return { results: [] };
      if (cmd === 'slsk_download_song') {
        const request = a.request as Record<string, unknown>;
        requests.push(request);
        return { id: request.id, kind: 'song', group: request.group, releaseId: 'x', album: 'x', artist: 'x', cover: null, state: 'searching', message: '', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null };
      }
      return undefined;
    });
    const id = addImport({ source: 'list', id: 'l', name: 'L', owner: null, cover: null, total: null, songs: [{ title: 'Nights', artists: ['Frank Ocean'], album: 'Blonde', lengthMs: 307000, appleId: null, cover: null, explicit: false }] }, 'any');
    await startImport(id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    emit('slsk-job', { id: requests[0].id, kind: 'song', group: id, releaseId: 'x', album: 'x', artist: 'x', cover: null, state: 'failed', code: 'download', message: 'No copy of this song could be downloaded.', bytes: 0, total: 0, filesDone: 0, filesTotal: 1, source: null, path: null });
    expect(usePlaylistImports.getState().imports[id].songs[0].state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
  } finally {
    vi.useRealTimers();
  }
});

it('an exported CSV keeps its playlist name', async () => {
  const { listName, readPlaylist } = await import('../src/services/playlistImport');
  const csv = 'Track name,Artist name,Album,Playlist name,Type,ISRC\nNights,Frank Ocean,Blonde,explosive diarrhea,Playlist,USUM71607009';
  expect(listName(csv)).toBe('explosive diarrhea');
  expect((await readPlaylist(csv)).name).toBe('explosive diarrhea');
  // Otherwise the file's name, else a plain one.
  expect((await readPlaylist('Frank Ocean - Nights', undefined, 'Road Trip.csv')).name).toBe('Road Trip');
  expect((await readPlaylist('Frank Ocean - Nights')).name).toBe('Pasted songs');
});

it('CSV files with old Mac line endings or line breaks inside quotes still read', () => {
  const mac = 'Title,Artist\rNights,Frank Ocean\rIvy,Frank Ocean';
  expect(parseSongList(mac).map((s) => s.title)).toEqual(['Nights', 'Ivy']);
  const quoted = 'Title,Artist\n"Line\nbreak",X\nNext,Y';
  expect(parseSongList(quoted).map((s) => [s.title, s.artists])).toEqual([
    ['Line break', ['X']],
    ['Next', ['Y']],
  ]);
});

it('a music video credit before the dash stays with the artist', () => {
  expect(songFromVideo('Drake ft. Rihanna - Too Good (Official Video)', 'DrakeVEVO')).toEqual({ title: 'Too Good', artists: ['Drake', 'Rihanna'] });
  expect(songFromVideo('Too Good (feat. Rihanna)', 'Drake - Topic')).toEqual({ title: 'Too Good', artists: ['Drake - Topic', 'Rihanna'] });
});

/** A backend whose song jobs are answered by `answer` (the request in, what to send back). */
function songBackend(answer: (request: Record<string, unknown>) => Promise<unknown> | unknown, catalogRows: () => Promise<unknown> = async () => ({ results: [] })) {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw' } }));
  useMusicPlayer.setState({ api: {} as never, library: { tracks: [], albums: [], artists: [], playlists: [] } });
  const requests: Record<string, unknown>[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'slsk_status' || cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'music_catalog') return catalogRows();
    if (cmd === 'slsk_download_song') {
      const request = a.request as Record<string, unknown>;
      requests.push(request);
      return answer(request);
    }
    return undefined;
  });
  return requests;
}

const songJob = (request: Record<string, unknown>, patch: Record<string, unknown>) => ({
  id: request.id,
  kind: 'song',
  group: request.group,
  releaseId: 'x',
  album: 'x',
  artist: 'x',
  cover: null,
  state: 'searching',
  message: '',
  bytes: 0,
  total: 0,
  filesDone: 0,
  filesTotal: 1,
  source: null,
  path: null,
  ...patch,
});

const plainSong = (title: string, artist: string) => ({ title, artists: [artist], album: null, lengthMs: null, appleId: null, cover: null, explicit: false });

it('a song whose job fails before its start has even answered isn’t left searching', async () => {
  songBackend((request) => {
    // The job fails at once: its update arrives before the command returns.
    emit('slsk-job', songJob(request, { state: 'failed', code: 'no-match', message: 'Nobody on Soulseek is sharing this song right now.' }));
    return songJob(request, { state: 'searching' });
  });
  const id = addImport({ source: 'list', id: 'l', name: 'L', owner: null, cover: null, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
  await startImport(id);
  const song = () => usePlaylistImports.getState().imports[id].songs[0];
  await vi.waitFor(() => expect(song()).toMatchObject({ state: 'failed', message: 'Nobody on Soulseek is sharing this song right now.' }));
  expect(usePlaylistImports.getState().imports[id].running).toBe(false);
});

it('Stop stops a song that’s still being matched: it isn’t downloaded after all', async () => {
  let answerCatalog: (rows: unknown) => void = () => {};
  const requests = songBackend(
    (request) => songJob(request, {}),
    () => new Promise((resolve) => (answerCatalog = resolve)),
  );
  const id = addImport({ source: 'list', id: 'l', name: 'L', owner: null, cover: null, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
  await startImport(id);
  const song = () => usePlaylistImports.getState().imports[id].songs[0];
  await vi.waitFor(() => expect(song().state).toBe('matching'));
  stopImport(id);
  answerCatalog({ results: [] });
  await new Promise((r) => setTimeout(r, 20));
  expect(requests).toHaveLength(0);
  expect(song().state).toBe('waiting');
});

it('a song listed twice is downloaded once', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const requests = songBackend((request) => songJob(request, {}));
    const id = addImport({ source: 'list', id: 'l', name: 'L', owner: null, cover: null, total: null, songs: [plainSong('Moonlight', 'Kali Uchis'), plainSong('Moonlight', 'Kali Uchis')] }, 'any');
    await startImport(id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const songs = () => usePlaylistImports.getState().imports[id].songs;
    // Both start together; the second waits for the first rather than failing as "already downloading".
    await vi.waitFor(() => expect(songs().map((s) => s.state).sort()).toEqual(['searching', 'waiting']));
    const first = songs().findIndex((s) => s.state === 'searching');
    emit('slsk-job', songJob(requests[0], { state: 'done', path: 'C:/Music/Kali Uchis/Singles/Moonlight.flac' }));
    await vi.advanceTimersByTimeAsync(21_000);
    await vi.waitFor(() => expect(songs()[1 - first]).toMatchObject({ state: 'done', path: 'C:/Music/Kali Uchis/Singles/Moonlight.flac' }));
    expect(requests).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('another playlist that only shares a name isn’t overwritten', async () => {
  const requests = songBackend((request) => songJob(request, {}));
  useMusicPlayer.setState({ api: {} as never, library: { tracks: [], albums: [], artists: [], playlists: [{ id: 41, name: 'Pasted songs', trackIds: [1], updatedAt: 0 }] } });
  usePlaylistImports.setState((s) => ({
    imports: { ...s.imports, old: { id: 'old', source: 'list', sourceId: 'list-1', name: 'Pasted songs', owner: null, cover: null, total: null, songs: [], quality: 'any', running: false, playlistId: 41, finishing: false } },
    order: ['old', ...s.order],
  }));
  const id = addImport({ source: 'list', id: 'list-2', name: 'Pasted songs', owner: null, cover: null, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
  await startImport(id);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  scan.files = new Map([['C:\\Music\\Kali Uchis\\Singles\\Moonlight.flac', { id: 12, mtime: 0, size: 1 }]]);
  emit('slsk-job', songJob(requests[0], { state: 'done', path: 'C:/Music/Kali Uchis/Singles/Moonlight.flac' }));
  await vi.waitFor(() => expect(createPlaylist).toHaveBeenCalledWith('Pasted songs', [12]));
  expect(setPlaylistTracks).not.toHaveBeenCalled();
  // A pasted list has no artwork: the playlist keeps its mosaic.
  expect(importPlaylistCover).not.toHaveBeenCalled();
});

it('the source playlist’s artwork becomes the cover of the playlist an import makes, and of the one importing it again updates', async () => {
  const requests = songBackend((request) => songJob(request, {}));
  const cover = 'https://i.scdn.co/image/ab67706c0000da84';
  const id = addImport({ source: 'spotify', id: 'sp1', name: 'Road Trip', owner: null, cover, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
  await startImport(id);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  scan.files = new Map([['C:\\Music\\Kali Uchis\\Singles\\Moonlight.flac', { id: 12, mtime: 0, size: 1 }]]);
  emit('slsk-job', songJob(requests[0], { state: 'done', path: 'C:/Music/Kali Uchis/Singles/Moonlight.flac' }));
  await vi.waitFor(() => expect(importPlaylistCover).toHaveBeenCalledWith(77, cover));
  expect(createPlaylist).toHaveBeenCalledWith('Road Trip', [12]);
  // Saved once the playlist exists.
  expect(vi.mocked(createPlaylist).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(importPlaylistCover).mock.invocationCallOrder[0]);

  // The same playlist imported again (new artwork since): its playlist is updated, cover included.
  useMusicPlayer.setState((s) => ({ library: { ...s.library!, playlists: [{ id: 77, name: 'Road Trip', trackIds: [12], updatedAt: 0 }] } }));
  vi.mocked(importPlaylistCover).mockClear();
  const again = addImport({ source: 'spotify', id: 'sp1', name: 'Road Trip', owner: null, cover: `${cover}-new`, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
  useMusicPlayer.setState((s) => ({ library: { ...s.library!, tracks: [{ id: 12, title: 'Moonlight', artist: 'Kali Uchis', albumArtist: 'Kali Uchis' } as MusicTrack] } }));
  await startImport(again);
  await vi.waitFor(() => expect(setPlaylistTracks).toHaveBeenCalledWith(77, [12]));
  await vi.waitFor(() => expect(importPlaylistCover).toHaveBeenCalledWith(77, `${cover}-new`));
  expect(createPlaylist).toHaveBeenCalledTimes(1);
});

it('artwork that can’t be saved doesn’t stop the playlist being made', async () => {
  const requests = songBackend((request) => songJob(request, {}));
  vi.mocked(importPlaylistCover).mockRejectedValue(new Error('Artwork unavailable'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const id = addImport({ source: 'apple', id: 'pl.1', name: 'Chill', owner: null, cover: 'https://is1-ssl.mzstatic.com/a/600x600SC.jpg', total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
  await startImport(id);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  scan.files = new Map([['C:\\Music\\Kali Uchis\\Singles\\Moonlight.flac', { id: 12, mtime: 0, size: 1 }]]);
  emit('slsk-job', songJob(requests[0], { state: 'done', path: 'C:/Music/Kali Uchis/Singles/Moonlight.flac' }));
  await vi.waitFor(() => expect(useLibraryStore.getState().toasts.map((t) => t.message)).toEqual(['Chill is in your music library']));
  expect(usePlaylistImports.getState().imports[id].playlistId).toBe(77);
  warn.mockRestore();
});

it('while Soulseek pauses the account, sign-ins wait longer each time, and the import says why', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const paused = 'Soulseek is pausing this account for a while (it does that after a lot of searching). TruongFlix carries on by itself once it’s let back in.';
    let signIns = 0;
    let letIn = true;
    const requests = songBackend((request) => songJob(request, {}));
    const backend = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'slsk_connect') {
        signIns++;
        if (letIn) return { state: 'online', username: 'me', message: '' };
        useMusicDownloads.setState({ status: { state: 'error', username: 'me', message: paused } });
        throw paused;
      }
      return backend(cmd, args);
    });
    const id = addImport({ source: 'list', id: 'l', name: 'L', owner: null, cover: null, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
    await startImport(id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // Cut off; the app's own reconnects fail too.
    letIn = false;
    signIns = 0;
    emit('slsk-status', { state: 'error', username: 'me', message: paused });
    emit('slsk-job', songJob(requests[0], { state: 'failed', code: 'connection', message: 'The connection to Soulseek dropped' }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(signIns).toBe(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(signIns).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signIns).toBe(2);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(signIns).toBe(2);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(signIns).toBe(3);
    // Let back in: the import carries on at once.
    letIn = true;
    emit('slsk-status', { state: 'online', username: 'me', message: '' });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
  } finally {
    vi.useRealTimers();
  }
});

it('changing the quality in Settings changes the imports that follow it, and tries their wrong-quality songs again', async () => {
  // The first song has no lossless copy; the second is still being searched for (the import runs on).
  const requests = songBackend((request) => {
    if (request.quality === 'lossless' && String(JSON.stringify(request)).includes('Sh*t'))
      emit('slsk-job', songJob(request, { state: 'failed', code: 'quality', message: 'There are copies of this song, but none in lossless (FLAC).' }));
    return songJob(request, { state: 'searching' });
  });
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, soulseek_quality: 'lossless' } }));
  const id = addImport({ source: 'list', id: 'q', name: 'Q', owner: null, cover: null, total: null, songs: [plainSong('My Sh*t', 'A Boogie wit da Hoodie'), plainSong('Nights', 'Frank Ocean')] }, 'lossless');
  const own = addImport({ source: 'list', id: 'q2', name: 'Q2', owner: null, cover: null, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'lossless');
  setImportQuality(own, 'mp3');
  await startImport(id);
  const song = () => usePlaylistImports.getState().imports[id].songs[0];
  await vi.waitFor(() => expect(song()).toMatchObject({ state: 'failed', code: 'quality' }));

  vi.mocked(invoke).mockClear();
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, soulseek_quality: 'any' } }));
  expect(importQuality(usePlaylistImports.getState().imports[id])).toBe('any');
  // An import given its own quality keeps it.
  expect(importQuality(usePlaylistImports.getState().imports[own])).toBe('mp3');
  // The song is searched for again, now in any quality.
  await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3));
  expect(requests.at(-1)).toMatchObject({ quality: 'any' });
  expect(JSON.stringify(requests.at(-1))).toContain('Sh*t');
});

it('an import made before Settings was switched to Best downloads in Best when started again', async () => {
  const requests = songBackend((request) => songJob(request, {}));
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, soulseek_quality: 'lossless' } }));
  const id = addImport({ source: 'list', id: 'old', name: 'Old', owner: null, cover: null, total: null, songs: [plainSong('She Want Some More', 'Lil Tecca')] }, 'lossless');
  // Switched while the app wasn't running (or before imports followed Settings).
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, soulseek_quality: 'any' } }), false);
  usePlaylistImports.setState((s) => ({ imports: { ...s.imports, [id]: { ...s.imports[id], songs: s.imports[id].songs.map((x) => ({ ...x, state: 'failed' as const, message: 'There are copies of this song, but none in lossless (FLAC).' })) } } }));
  await startImport(id);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ quality: 'any' });
});

const albumSong = (title: string, artists: string[], album: string | null) => ({ title, artists, album, lengthMs: null, appleId: null, cover: null, explicit: false });

it('songs of one album waiting together go together; the rest, and too few of an album, go one by one', async () => {
  const { albumGroups, albumKey } = await import('../src/services/playlistImport');
  const store = (album: string, albumArtist: string) => ({ title: 'x', artist: albumArtist, album, albumArtist, track: 1, disc: 1, date: null, genre: null, cover: null, lengthMs: null });
  const songs = [
    { ...albumSong('Ain’t No Time', ['Future'], 'EVOL'), key: '0', store: null },
    { ...albumSong('Housewife', ['Tate McRae'], null), key: '1', store: null },
    // Its store details name the album too (and its main artist, credited with a guest).
    { ...albumSong('Low Life', ['Future', 'The Weeknd'], null), key: '2', store: store('EVOL', 'Future & The Weeknd') },
    { ...albumSong('Seven Rings', ['Future'], 'evol'), key: '3', store: null },
    // Searched for on its own already: its album's copies didn't have it.
    { ...albumSong('Maybach', ['Future'], 'EVOL'), key: '4', store: null, solo: true },
    // Two of another album are fetched together too.
    { ...albumSong('Nights', ['Frank Ocean'], 'Blonde'), key: '5', store: null },
    { ...albumSong('Ivy', ['Frank Ocean'], 'Blonde'), key: '6', store: null },
    // Another album that only shares the name.
    { ...albumSong('EVOL', ['Someone Else'], 'EVOL'), key: '7', store: null },
    { ...albumSong('Program', ['Future'], 'EVOL'), key: '8', store: null },
    // A video album's songs are filed under their real albums.
    { ...albumSong('Clip', ['Future'], 'EVOL (Video)'), key: '9', store: null },
  ];
  expect(albumKey(songs[0])).toBe(albumKey(songs[2]));
  expect(albumKey(songs[9])).toBeNull();
  expect(albumGroups(songs).map((unit) => unit.map((s) => s.key))).toEqual([['0', '2', '3', '8'], ['1'], ['4'], ['5', '6'], ['7'], ['9']]);
  // A song alone from its album is searched for on its own.
  expect(albumGroups(songs.slice(0, 2)).map((unit) => unit.map((s) => s.key))).toEqual([['0'], ['1']]);
});

/** A backend where album downloads and song downloads are recorded (the store knows the album's songs). */
function albumBackend() {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_directories: ['C:/Music'], soulseek_username: 'me', soulseek_password: 'pw', soulseek_quality: 'mp3' } }));
  useMusicPlayer.setState({ api: {} as never, library: { tracks: [], albums: [], artists: [], playlists: [] } });
  const tracks: Record<string, [string, number]> = { 'Ain’t No Time': ['Future', 1], 'In Her Mouth': ['Future', 2], 'Low Life': ['Future & The Weeknd', 6], Program: ['Future', 9] };
  const calls = { albums: [] as Record<string, unknown>[], songs: [] as Record<string, unknown>[], cancelled: [] as string[] };
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'slsk_status' || cmd === 'slsk_connect') return { state: 'online', username: 'me', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'live_artwork') return 'C:/cache/evol.img';
    if (cmd === 'music_catalog') {
      const url = decodeURIComponent(String(a.url));
      const title = Object.keys(tracks).find((t) => url.includes(t));
      if (!title) return { results: [] };
      const [artist, trackNumber] = tracks[title];
      return { results: [row(title, artist, 200000, { collectionName: 'EVOL', collectionArtistName: 'Future', trackNumber, releaseDate: '2016-02-06T08:00:00Z' })] };
    }
    if (cmd === 'slsk_download_album_songs') {
      const request = a.request as { songs: Record<string, unknown>[] };
      calls.albums.push(request);
      return request.songs.map((s) => songJob(s, {}));
    }
    if (cmd === 'slsk_download_song') {
      const request = a.request as Record<string, unknown>;
      calls.songs.push(request);
      return songJob(request, {});
    }
    if (cmd === 'slsk_cancel') calls.cancelled.push(String(a.id));
    return undefined;
  });
  return calls;
}

const evol = () => [
  albumSong('Ain’t No Time', ['Future'], 'EVOL'),
  albumSong('In Her Mouth', ['Future'], 'EVOL'),
  albumSong('Low Life', ['Future', 'The Weeknd'], 'EVOL'),
  albumSong('Program', ['Future'], 'EVOL'),
];

it('songs of one album are fetched together: one album search instead of one per song, each song still filed on its own', async () => {
  const calls = albumBackend();
  const id = addImport({ source: 'spotify', id: 'evol', name: 'Mix', owner: null, cover: null, total: null, songs: [...evol(), plainSong('Housewife', 'Tate McRae')] }, 'lossless');
  await startImport(id);
  await vi.waitFor(() => expect(calls.albums).toHaveLength(1));
  await vi.waitFor(() => expect(calls.songs).toHaveLength(1));
  const songs = () => usePlaylistImports.getState().imports[id].songs;
  // One download for the album's four songs, in the quality Settings asks for; one for the other song.
  const album = calls.albums[0] as { group: string; album: string; albumArtist: string; quality: string; songs: Record<string, unknown>[] };
  expect(album).toMatchObject({ group: id, album: 'EVOL', albumArtist: 'Future', quality: 'mp3', destination: 'C:/Music' });
  expect(album.songs.map((s) => [s.title, s.track])).toEqual([['Ain’t No Time', 1], ['In Her Mouth', 2], ['Low Life', 6], ['Program', 9]]);
  // Each is tagged with its own store details, as a song fetched on its own would be.
  expect(album.songs[2]).toMatchObject({ group: id, artist: 'Future & The Weeknd', album: 'EVOL', albumArtist: 'Future', date: '2016-02-06', quality: 'mp3', coverPath: 'C:/cache/evol.img' });
  expect(calls.songs[0]).toMatchObject({ title: 'Housewife' });
  await vi.waitFor(() => expect(songs().slice(0, 4).map((s) => s.state)).toEqual(['searching', 'searching', 'searching', 'searching']));

  // Each song shows its own state.
  const [a, b, c, d] = album.songs;
  emit('slsk-job', songJob(a, { state: 'downloading', bytes: 5, total: 10, source: { user: 'evol_fan', format: 'mp3' } }));
  emit('slsk-job', songJob(b, { state: 'queued', source: { user: 'evol_fan', format: 'mp3' } }));
  expect(songs()[0]).toMatchObject({ state: 'downloading', progress: 0.5, from: 'evol_fan' });
  expect(songs()[1]).toMatchObject({ state: 'queued', from: 'evol_fan' });
  emit('slsk-job', songJob(a, { state: 'done', path: 'C:/Music/Future/EVOL (2016)/01 - Ain’t No Time.mp3' }));
  emit('slsk-job', songJob(b, { state: 'done', path: 'C:/Music/Future/EVOL (2016)/02 - In Her Mouth.mp3' }));
  emit('slsk-job', songJob(c, { state: 'done', path: 'C:/Music/Future/EVOL (2016)/06 - Low Life.mp3' }));
  // The one the album's copies didn't have is searched for on its own.
  emit('slsk-job', songJob(d, { state: 'failed', code: 'alone', message: 'The album’s copies on Soulseek don’t have it' }));
  expect(songs().map((s) => s.state).slice(0, 3)).toEqual(['done', 'done', 'done']);
  await vi.waitFor(() => expect(calls.songs).toHaveLength(2));
  expect(calls.songs[1]).toMatchObject({ title: 'Program', track: 9, album: 'EVOL', quality: 'mp3' });
  await vi.waitFor(() => expect(songs()[3]).toMatchObject({ state: 'searching', solo: true, message: '' }));
  expect(calls.albums).toHaveLength(1);
});

it('Stop cancels an album download and every song in it', async () => {
  const calls = albumBackend();
  const id = addImport({ source: 'spotify', id: 'evol2', name: 'Mix', owner: null, cover: null, total: null, songs: evol().slice(0, 3) }, 'lossless');
  await startImport(id);
  await vi.waitFor(() => expect(calls.albums).toHaveLength(1));
  const songs = () => usePlaylistImports.getState().imports[id].songs;
  await vi.waitFor(() => expect(songs().every((s) => s.state === 'searching')).toBe(true));
  const jobs = (calls.albums[0] as { songs: Record<string, unknown>[] }).songs;
  emit('slsk-job', songJob(jobs[0], { state: 'queued', source: { user: 'evol_fan', format: 'mp3' } }));
  stopImport(id);
  expect(calls.cancelled.sort()).toEqual(jobs.map((j) => String(j.id)).sort());
  for (const job of jobs) emit('slsk-job', songJob(job, { state: 'cancelled' }));
  expect(songs().map((s) => s.state)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  expect(calls.songs).toHaveLength(0);
});

it('an album download that can’t start leaves its songs to be found one by one', async () => {
  const calls = albumBackend();
  const backend = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'slsk_download_album_songs') throw new Error('This song is already downloading.');
    return backend(cmd, args as never);
  });
  const id = addImport({ source: 'spotify', id: 'evol3', name: 'Mix', owner: null, cover: null, total: null, songs: evol().slice(0, 3) }, 'lossless');
  await startImport(id);
  await vi.waitFor(() => expect(calls.songs).toHaveLength(3));
  expect(calls.albums).toHaveLength(0);
  expect(usePlaylistImports.getState().imports[id].songs.every((s) => s.solo)).toBe(true);
});

it('importing a playlist again takes over an empty playlist of its name instead of making a second', async () => {
  const requests = songBackend((request) => songJob(request, {}));
  useMusicPlayer.setState({ api: {} as never, library: { tracks: [], albums: [], artists: [], playlists: [{ id: 77, name: 'Road trip', trackIds: [], updatedAt: 0 }] } });
  const id = addImport({ source: 'list', id: 'again', name: 'Road trip', owner: null, cover: null, total: null, songs: [plainSong('Moonlight', 'Kali Uchis')] }, 'any');
  await startImport(id);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  scan.files = new Map([['C:\\Music\\Kali Uchis\\Singles\\Moonlight.flac', { id: 12, mtime: 0, size: 1 }]]);
  emit('slsk-job', songJob(requests[0], { state: 'done', path: 'C:/Music/Kali Uchis/Singles/Moonlight.flac' }));
  await vi.waitFor(() => expect(setPlaylistTracks).toHaveBeenCalledWith(77, [12]));
  expect(createPlaylist).not.toHaveBeenCalled();
});
