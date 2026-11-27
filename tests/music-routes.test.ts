import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from './sqlite';

let conn = memoryDb();
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../src/services/db', () => ({
  getDb: vi.fn(async () => conn),
  loadLibrary: vi.fn(async () => ({ movies: [], series: [], episodes: [] })),
  recordProgress: vi.fn(),
  logWatchTime: vi.fn(),
  setMyList: vi.fn(),
  getSelectedSubtitlePath: vi.fn(async () => null),
  readLiveData: vi.fn(async (_k: string, fallback: unknown) => fallback),
  writeLiveData: vi.fn(),
}));
let streamCount = 0;
vi.mock('../src/services/streaming', () => ({
  planStream: () => ({ format: 'direct' }),
  probeStream: vi.fn(async () => null),
  registerStream: vi.fn(async () => `tok${++streamCount}`),
  streamUrl: vi.fn(async (token: string) => ({ url: `http://127.0.0.1:8732/stream/${token}/file`, path: `/stream/${token}/file`, offset: 0 })),
  releaseStream: vi.fn(),
  durationOf: () => 100,
}));
vi.mock('../src/services/limits', () => ({ limitStatus: vi.fn(async () => ({ blocked: null, remaining: null })), blockedMessage: () => '' }));
vi.mock('../src/services/torrents', () => ({ downloadBlockingPlayback: () => null, stillDownloadingMessage: () => '' }));
vi.mock('../src/services/player', () => ({ subtitleOptions: () => [], playLive: vi.fn(), noteUserActivity: vi.fn() }));
vi.mock('../src/services/cast', () => ({ castControl: vi.fn(), castSeek: vi.fn(), stopCasting: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false }) }));
vi.mock('../src/services/subtitles', () => ({ languageName: (s: string) => s }));

let remote: typeof import('../src/services/remoteapi');
let mdb: typeof import('../src/services/musicdb');
let streaming: typeof import('../src/services/streaming');
let core: typeof import('@tauri-apps/api/core');
let ids: Record<string, number>;

const adult = { id: 1, name: 'Ian', color: '#E50914', maturity: 'all', pin: '', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const other = { id: 2, name: 'Sam', color: '#2E86DE', maturity: 'all', pin: '', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const locked = { id: 3, name: 'Locked', color: '#2E86DE', maturity: 'all', pin: 'hash', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const A = { session: 'sessA', device: 'iPhone · Safari' };
const B = { session: 'sessB', device: 'Pixel · Chrome' };

const get = (path: string, query: Record<string, string>, caller = A) => remote.route(caller, 'GET', path, query, {});
const post = (path: string, body: Record<string, unknown>, caller = A) => remote.route(caller, 'POST', path, {}, body);

const base = { file_size: 1, mtime: 1, album_artist: null, genre: null, track_no: null, track_total: null, disc_no: null, disc_total: null, year: null, duration: 180, sample_rate: null, bit_depth: null, bitrate: null, channels: 2, cover: null, lyrics_source: null, error: null };

beforeEach(async () => {
  conn = memoryDb();
  vi.resetModules();
  streamCount = 0;
  mdb = await import('../src/services/musicdb');
  streaming = await import('../src/services/streaming');
  core = await import('@tauri-apps/api/core');
  const { useLibraryStore } = await import('../src/store/useLibraryStore');
  useLibraryStore.setState({ profiles: [adult, other, locked] as never, torrents: [] });
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, music_lyrics_online: true } }));
  remote = await import('../src/services/remoteapi');
  await mdb.upsertMusicFiles([
    { ...base, file_path: '/m/a.mp3', title: 'Plain MP3', artist: 'Luma', album: 'Neon', codec: 'mp3', lyrics: '[00:01.00]Hi' },
    { ...base, file_path: '/m/b.m4a', title: 'Lossless', artist: 'Luma', album: 'Neon', codec: 'alac', lyrics: null },
  ] as never);
  ids = Object.fromEntries((await mdb.loadMusic(1)).tracks.map((t) => [t.title, t.id]));
});

describe('/api/music', () => {
  it('returns the library with this profile’s favourites', async () => {
    await post('/music/favourite', { profile: 1, id: ids['Plain MP3'], value: true });
    const mine = (await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary;
    expect(mine.tracks.find((t) => t.title === 'Plain MP3')!.favourite).toBe(true);
    expect(mine.albums).toHaveLength(1);
    const theirs = (await get('/music/library', { profile: '2' }, B)) as import('../src/music/types').MusicLibrary;
    expect(theirs.tracks.every((t) => !t.favourite)).toBe(true);
  });

  it('checks the profile and its PIN', async () => {
    await expect(get('/music/library', { profile: '99' })).rejects.toMatchObject({ status: 404 });
    await expect(get('/music/library', { profile: '3' })).rejects.toMatchObject({ status: 403 });
  });

  it('streams the original file, or converts what the browser can’t play', async () => {
    const direct = (await post('/music/stream', { profile: 1, id: ids['Plain MP3'], codecs: ['mp3', 'aac'] })) as { url: string; transcoded: boolean };
    expect(direct).toEqual({ url: '/stream/tok1/file', transcoded: false });
    expect(vi.mocked(streaming.registerStream)).toHaveBeenLastCalledWith('/m/a.mp3', expect.objectContaining({ format: 'direct' }));
    const alac = (await post('/music/stream', { profile: 1, id: ids.Lossless, codecs: ['mp3', 'aac', 'bogus'] })) as { transcoded: boolean };
    expect(alac.transcoded).toBe(true);
    expect(vi.mocked(streaming.registerStream)).toHaveBeenLastCalledWith('/m/b.m4a', expect.objectContaining({ format: 'aac' }));
    const safari = (await post('/music/stream', { profile: 1, id: ids.Lossless, codecs: ['alac'] })) as { transcoded: boolean };
    expect(safari.transcoded).toBe(false);
    await expect(post('/music/stream', { profile: 1, id: 999, codecs: [] })).rejects.toMatchObject({ status: 404 });
    await expect(post('/music/stream', { profile: 1, id: 'x' })).rejects.toMatchObject({ status: 400 });
  });

  it('keeps a few streams per browser and releases the rest', async () => {
    for (let i = 0; i < 5; i++) await post('/music/stream', { profile: 1, id: ids['Plain MP3'], codecs: ['mp3'] });
    expect(vi.mocked(streaming.releaseStream).mock.calls.map((c) => c[0])).toEqual(['tok1', 'tok2']);
    remote.endRemoteSession(A.session);
    expect(vi.mocked(streaming.releaseStream).mock.calls.map((c) => c[0])).toEqual(['tok1', 'tok2', 'tok3', 'tok4', 'tok5']);
  });

  it('serves file lyrics, then online lyrics (looked up once)', async () => {
    expect(await get('/music/lyrics', { profile: '1', id: String(ids['Plain MP3']) })).toEqual({ text: '[00:01.00]Hi', synced: true, source: 'embedded' });
    vi.mocked(core.invoke).mockImplementation(async (cmd: string) => (cmd === 'music_lyrics_fetch' ? { synced: '[00:02.00]Online', plain: 'Online', instrumental: false, provider: 'netease' } : null));
    const first = await get('/music/lyrics', { profile: '1', id: String(ids.Lossless) });
    expect(first).toMatchObject({ text: '[00:02.00]Online', synced: true, source: 'netease' });
    const second = await get('/music/lyrics', { profile: '1', id: String(ids.Lossless) });
    expect(second).toEqual(first);
    expect(vi.mocked(core.invoke).mock.calls.filter((c) => c[0] === 'music_lyrics_fetch')).toHaveLength(1);
  });

  it('manages this profile’s playlists only', async () => {
    const p = (await post('/music/playlists/create', { profile: 1, name: 'Mix', trackIds: [ids['Plain MP3']] })) as import('../src/music/types').MusicPlaylist;
    expect(p).toMatchObject({ name: 'Mix', trackIds: [ids['Plain MP3']] });
    expect(await post('/music/playlists/add', { profile: 1, id: p.id, trackIds: [ids.Lossless] })).toEqual({ trackIds: [ids.Lossless] });
    expect(await post('/music/playlists/tracks', { profile: 1, id: p.id, trackIds: [ids.Lossless, ids['Plain MP3']] })).toEqual({ trackIds: [ids.Lossless, ids['Plain MP3']] });
    await post('/music/playlists/rename', { profile: 1, id: p.id, name: 'Best' });
    await expect(post('/music/playlists/rename', { profile: 2, id: p.id, name: 'Mine now' }, B)).rejects.toMatchObject({ status: 404 });
    await expect(post('/music/playlists/delete', { profile: 2, id: p.id }, B)).rejects.toMatchObject({ status: 404 });
    const lib = (await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary;
    expect(lib.playlists).toEqual([expect.objectContaining({ name: 'Best', trackIds: [ids.Lossless, ids['Plain MP3']] })]);
    await post('/music/playlists/delete', { profile: 1, id: p.id });
    expect(((await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary).playlists).toEqual([]);
  });

  it('sets a playlist’s description and cover, for this profile only', async () => {
    const p = (await post('/music/playlists/create', { profile: 1, name: 'Mix' })) as import('../src/music/types').MusicPlaylist;
    expect(p).toMatchObject({ description: '', cover: null, customCover: false });
    expect(await post('/music/playlists/description', { profile: 1, id: p.id, description: '  Songs for\nthe   drive  ' })).toEqual({ description: 'Songs for the drive' });
    await expect(post('/music/playlists/description', { profile: 2, id: p.id, description: 'Mine' }, B)).rejects.toMatchObject({ status: 404 });

    const art = `${'c'.repeat(32)}.png`;
    vi.mocked(core.invoke).mockImplementation(async (cmd: string) => (cmd === 'music_cover_store' ? art : null));
    // The browser sends the picture's bytes as base64.
    const png = [0x89, 0x50, 0x4e, 0x47, 1, 2];
    expect(await post('/music/playlists/cover', { profile: 1, id: p.id, image: btoa(String.fromCharCode(...png)) })).toEqual({ cover: art, customCover: true });
    expect(vi.mocked(core.invoke)).toHaveBeenCalledWith('music_cover_store', { data: png });
    // Another profile's playlist: refused before anything is saved.
    vi.mocked(core.invoke).mockClear();
    await expect(post('/music/playlists/cover', { profile: 2, id: p.id, image: btoa('x') }, B)).rejects.toMatchObject({ status: 404 });
    expect(vi.mocked(core.invoke)).not.toHaveBeenCalledWith('music_cover_store', expect.anything());
    await expect(post('/music/playlists/cover', { profile: 1, id: p.id, image: 42 })).rejects.toMatchObject({ status: 400 });
    vi.mocked(core.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'music_cover_store') throw 'Pick a JPEG, PNG, WebP or GIF picture';
      return null;
    });
    await expect(post('/music/playlists/cover', { profile: 1, id: p.id, image: btoa('<html>') })).rejects.toMatchObject({ status: 400 });

    let lib = (await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary;
    expect(lib.playlists[0]).toMatchObject({ description: 'Songs for the drive', cover: art, customCover: true });
    expect(await post('/music/playlists/cover', { profile: 1, id: p.id, image: null })).toEqual({ cover: null, customCover: false });
    expect(await post('/music/playlists/description', { profile: 1, id: p.id, description: '' })).toEqual({ description: '' });
    lib = (await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary;
    expect(lib.playlists[0]).toMatchObject({ description: '', cover: null, customCover: false });
  });

  it('pins and unpins albums and playlists for this profile only', async () => {
    const lib0 = (await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary;
    expect(lib0.pins).toEqual([]);
    const albumId = lib0.albums[0].id;
    const p = (await post('/music/playlists/create', { profile: 1, name: 'Mix' })) as import('../src/music/types').MusicPlaylist;
    expect(await post('/music/pin', { profile: 1, kind: 'album', id: albumId, value: true })).toEqual({ ok: true });
    await post('/music/pin', { profile: 1, kind: 'playlist', id: p.id, value: true });
    const mine = (await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary;
    expect(mine.pins).toEqual([{ kind: 'album', id: albumId }, { kind: 'playlist', id: p.id }]);
    const theirs = (await get('/music/library', { profile: '2' }, B)) as import('../src/music/types').MusicLibrary;
    expect(theirs.pins).toEqual([]);
    await expect(post('/music/pin', { profile: 2, kind: 'playlist', id: p.id, value: true }, B)).rejects.toMatchObject({ status: 404 });
    await expect(post('/music/pin', { profile: 1, kind: 'artist', id: albumId, value: true })).rejects.toMatchObject({ status: 400 });
    await expect(post('/music/pin', { profile: 1, kind: 'album', id: 'x', value: true })).rejects.toMatchObject({ status: 400 });
    await post('/music/pin', { profile: 1, kind: 'album', id: albumId, value: false });
    expect(((await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary).pins).toEqual([{ kind: 'playlist', id: p.id }]);
  });

  it('records plays for Listen Now', async () => {
    await post('/music/played', { profile: 1, id: ids.Lossless });
    const lib = (await get('/music/library', { profile: '1' })) as import('../src/music/types').MusicLibrary;
    expect(lib.tracks.find((t) => t.id === ids.Lossless)!.plays).toBe(1);
    expect(lib.albums[0].lastPlayed).not.toBeNull();
    await expect(post('/music/played', { profile: 1, id: 4242 })).rejects.toMatchObject({ status: 404 });
  });

  it('stores how long a play was listened to, for this profile only', async () => {
    await post('/music/played', { profile: 1, id: ids.Lossless });
    await post('/music/listened', { profile: 2, id: ids.Lossless, seconds: 5 }, B);
    await post('/music/listened', { profile: 1, id: ids.Lossless, seconds: 'nope' });
    expect((await mdb.listMusicPlays(1))[0].seconds).toBeNull();
    await post('/music/listened', { profile: 1, id: ids.Lossless, seconds: 42 });
    expect((await mdb.listMusicPlays(1))[0].seconds).toBe(42);
    await expect(post('/music/listened', { profile: 1, id: 0, seconds: 1 })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown music endpoints', async () => {
    await expect(post('/music/nope', { profile: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

describe('desktop playlist covers', () => {
  const desktop = async () => {
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState({ activeProfile: adult as never });
    return (await import('../src/services/music')).localApi('C:/cache/music-art');
  };

  it('keeps an imported playlist’s artwork on this computer, fetched once per address', async () => {
    const api = await desktop();
    const p = await api.createPlaylist('Road Trip', [ids['Plain MP3']]);
    const art = `${'a'.repeat(32)}.jpg`;
    vi.mocked(core.invoke).mockImplementation(async (cmd: string) => (cmd === 'music_cover_download' ? art : null));
    const url = 'https://i.scdn.co/image/ab67706c';
    expect(await api.importPlaylistCover!(p.id, url)).toEqual({ cover: art, customCover: false });
    expect(vi.mocked(core.invoke)).toHaveBeenCalledWith('music_cover_download', { url });
    // Importing it again with the same artwork fetches nothing.
    vi.mocked(core.invoke).mockClear();
    expect(await api.importPlaylistCover!(p.id, url)).toBeNull();
    expect(vi.mocked(core.invoke)).not.toHaveBeenCalled();
    expect((await api.library()).playlists[0]).toMatchObject({ cover: art, customCover: false });
    expect(api.artUrl(art)).toBe('asset://C:/cache/music-art/' + art);
  });

  it('a cover the user picked stays when the playlist is imported again, and taking it off shows the artwork again', async () => {
    const api = await desktop();
    const p = await api.createPlaylist('Road Trip');
    const imported = `${'a'.repeat(32)}.jpg`;
    const newer = `${'b'.repeat(32)}.jpg`;
    const mine = `${'d'.repeat(32)}.webp`;
    vi.mocked(core.invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'music_cover_download') return (args as { url: string }).url.endsWith('new') ? newer : imported;
      if (cmd === 'music_cover_store') return mine;
      return null;
    });
    await api.importPlaylistCover!(p.id, 'https://i.scdn.co/image/old');
    expect(await api.setPlaylistCover(p.id, new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toEqual({ cover: mine, customCover: true });
    expect(vi.mocked(core.invoke)).toHaveBeenCalledWith('music_cover_store', { data: [0x52, 0x49, 0x46, 0x46] });
    // New artwork at the source: kept, but the user's own cover stays shown.
    expect(await api.importPlaylistCover!(p.id, 'https://i.scdn.co/image/new')).toEqual({ cover: mine, customCover: true });
    expect(await api.setPlaylistCover(p.id, null)).toEqual({ cover: newer, customCover: false });
  });
});
