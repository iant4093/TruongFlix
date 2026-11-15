import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TogetherRoomSummary, TogetherState } from '../src/remote/together';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../src/services/db', () => ({
  loadLibrary: vi.fn(async () => ({ movies: [], series: [], episodes: [] })),
  recordProgress: vi.fn(async () => {}),
  logWatchTime: vi.fn(async () => {}),
  setMyList: vi.fn(async () => {}),
  getSelectedSubtitlePath: vi.fn(async () => null),
  getDb: vi.fn(),
  readLiveData: vi.fn(async (_key: string, fallback: unknown) => fallback),
  writeLiveData: vi.fn(async () => {}),
}));
vi.mock('../src/services/streaming', () => ({
  planStream: () => ({ format: 'direct' }),
  probeStream: vi.fn(async () => null),
  registerStream: vi.fn(async () => 'tok'),
  streamUrl: vi.fn(async () => ({ url: '', path: '/stream/tok/file', offset: 0 })),
  releaseStream: vi.fn(),
  durationOf: () => 100,
}));
vi.mock('../src/services/limits', () => ({ limitStatus: vi.fn(async () => ({ blocked: null, remaining: null })), blockedMessage: () => '' }));
vi.mock('../src/services/torrents', () => ({ downloadBlockingPlayback: () => null, stillDownloadingMessage: () => '' }));
vi.mock('../src/services/player', () => ({
  subtitleOptions: () => [],
  closeBuiltin: vi.fn(async () => {}),
  dismissPrompt: vi.fn(),
  exitMini: vi.fn(async () => {}),
  noteUserActivity: vi.fn(),
  play: vi.fn(async () => {}),
  playBuiltin: vi.fn(async () => {}),
  playerCommand: vi.fn(async () => {}),
  playerSet: vi.fn(async () => {}),
  playLive: vi.fn(async () => {}),
  seekLive: vi.fn(async () => {}),
  toggleFullscreen: vi.fn(async () => true),
}));
vi.mock('../src/services/cast', () => ({ castControl: vi.fn(), castSeek: vi.fn(async () => {}), stopCasting: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false }) }));
vi.mock('../src/services/subtitles', () => ({ languageName: (s: string) => s }));

const adult = { id: 1, name: 'Ian', color: '#E50914', maturity: 'all', pin: '', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const kid = { id: 2, name: 'Kids', color: '#F5B70A', maturity: 'kids', pin: '', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const locked = { id: 3, name: 'Locked', color: '#2E86DE', maturity: 'all', pin: '4321', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const movies = [
  { id: 1, title: 'Grown-up film', certification: 'R' },
  { id: 2, title: 'Family film', certification: 'G' },
];

const A = { session: 'sessA', device: 'iPhone · Safari' };
const B = { session: 'sessB', device: 'Windows PC · Edge' };
const K = { session: 'sessK', device: 'iPad · Safari' };

let remote: typeof import('../src/services/remoteapi');
let desktop: typeof import('../src/services/watchpartyDesktop');
let player: typeof import('../src/services/player');

beforeEach(async () => {
  vi.resetModules();
  const db = await import('../src/services/db');
  vi.mocked(db.getDb).mockResolvedValue({
    select: vi.fn(async (sql: string, [id]: number[]) => (sql.includes('FROM movies') ? movies.filter((m) => m.id === id) : [])),
  } as never);
  const { useLibraryStore } = await import('../src/store/useLibraryStore');
  useLibraryStore.setState({
    profiles: [adult, kid, locked] as never,
    activeProfile: adult as never,
    movies: [{ id: 2, title: 'Family film', file_path: '/Movies/Family.mp4' }] as never,
    playerSession: { target: { type: 'movie', id: 1, filePath: '/Movies/Grown.mkv', startTime: 0, label: 'Grown-up film' }, loadId: 'x' } as never,
    playerState: { time: 12, duration: 100, paused: false, loaded: true, buffering: false, seeking: false, speed: 1, load_id: 'x' } as never,
    toast: vi.fn(),
  });
  remote = await import('../src/services/remoteapi');
  desktop = await import('../src/services/watchpartyDesktop');
  player = await import('../src/services/player');
});

const call = (caller: typeof A, path: string, body: Record<string, unknown> = {}, method = 'POST', query: Record<string, string> = {}) => remote.route(caller, method, path, query, body);

describe('watch together API', () => {
  it('creates, joins by code, reports, polls and leaves', async () => {
    const room = (await call(A, '/together/create', { profile: 1, type: 'movie', id: 2, position: 20, playing: false })) as TogetherState;
    expect(room).toMatchObject({ label: 'Family film', playing: false, position: 20 });

    const rooms = (await call(B, '/together/rooms', {}, 'GET', { profile: '1' })) as TogetherRoomSummary[];
    expect(rooms).toEqual([{ code: room.code, label: 'Family film', title: { type: 'movie', id: 2 }, members: ['Ian · iPhone · Safari'] }]);

    const joined = (await call(B, '/together/join', { profile: 1, code: room.code })) as TogetherState;
    expect(joined.members.map((m) => m.device)).toEqual(['iPhone · Safari', 'Windows PC · Edge']);

    await call(B, '/together/poll', { code: room.code, buffering: false });
    const playing = (await call(A, '/together/report', { code: room.code, action: 'play', position: 21 })) as TogetherState;
    expect(playing).toMatchObject({ playing: true, held: false });
    const seen = (await call(B, '/together/poll', { code: room.code, since: joined.seq })) as TogetherState;
    expect(seen.events.map((e) => e.text)).toContain('Ian resumed');

    await expect(call(A, '/together/report', { code: room.code, action: 'explode' })).rejects.toMatchObject({ status: 400 });
    await call(A, '/together/leave', { code: room.code });
    await expect(call(A, '/together/poll', { code: room.code })).rejects.toMatchObject({ status: 404 });
    await expect(call(B, '/together/poll', { code: 'WRONG1' })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses profiles whose rating or PIN doesn’t allow the room’s title', async () => {
    const room = (await call(A, '/together/create', { profile: 1, type: 'movie', id: 1 })) as TogetherState;
    await expect(call(K, '/together/join', { profile: 2, code: room.code })).rejects.toMatchObject({ status: 403 });
    await expect(call(K, '/together/create', { profile: 2, type: 'movie', id: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(call(K, '/together/rooms', {}, 'GET', { profile: '2' })).resolves.toEqual([]);
    await expect(call(B, '/together/join', { profile: 3, code: room.code })).rejects.toMatchObject({ status: 403, message: 'This profile is locked' });
  });

  it('rate-limits polling per browser', async () => {
    const room = (await call(A, '/together/create', { profile: 1, type: 'movie', id: 2 })) as TogetherState;
    for (let i = 0; i < 40; i++) await call(A, '/together/poll', { code: room.code });
    await expect(call(A, '/together/poll', { code: room.code })).rejects.toMatchObject({ status: 429 });
  });

  it('lets the desktop player start a party that browsers join', async () => {
    await desktop.createParty();
    const state = desktop.useDesktopParty.getState().state!;
    expect(state).toMatchObject({ label: 'Grown-up film', playing: true });
    expect(state.members[0]).toMatchObject({ name: 'Ian', device: 'PC app', kind: 'desktop', you: true });
    const joined = (await call(A, '/together/join', { profile: 1, code: state.code })) as TogetherState;
    expect(joined.members).toHaveLength(2);
    await call(A, '/together/report', { code: state.code, action: 'pause', position: 30 });
    await desktop.leaveParty();
    expect(desktop.useDesktopParty.getState().state).toBeNull();
    expect(((await call(A, '/together/poll', { code: state.code })) as TogetherState).members.map((m) => m.kind)).toEqual(['browser']);
  });

  it('switches the desktop player to the room’s title when joining', async () => {
    const room = (await call(A, '/together/create', { profile: 1, type: 'movie', id: 2, position: 40, playing: true })) as TogetherState;
    await desktop.joinParty(room.code);
    expect(player.playBuiltin).toHaveBeenCalledWith(expect.objectContaining({ type: 'movie', id: 2, filePath: '/Movies/Family.mp4' }));
    const startTime = vi.mocked(player.playBuiltin).mock.calls[0][0].startTime;
    expect(startTime).toBeGreaterThanOrEqual(40);
    expect(startTime).toBeLessThan(41);
    await desktop.leaveParty();
  });
});
