import { beforeEach, describe, expect, it, vi } from 'vitest';
import { movie } from './fixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../src/services/db', () => ({
  loadLibrary: vi.fn(),
  recordProgress: vi.fn(async () => {}),
  logWatchTime: vi.fn(async () => {}),
  setMyList: vi.fn(async () => {}),
  getSelectedSubtitlePath: vi.fn(async () => null),
}));
let streamCount = 0;
vi.mock('../src/services/streaming', () => ({
  planStream: () => ({ format: 'direct' }),
  probeStream: vi.fn(async () => null),
  registerStream: vi.fn(async () => `tok${++streamCount}`),
  streamUrl: vi.fn(async (token: string) => ({ url: '', path: `/stream/${token}/file`, offset: 0 })),
  releaseStream: vi.fn(),
  durationOf: () => 100,
}));
vi.mock('../src/services/limits', () => ({ limitStatus: vi.fn(async () => ({ blocked: null, remaining: null })), blockedMessage: () => 'It’s bedtime' }));
vi.mock('../src/services/torrents', () => ({ downloadBlockingPlayback: () => null, stillDownloadingMessage: () => '' }));
vi.mock('../src/services/player', () => ({ subtitleOptions: () => [] }));
vi.mock('../src/services/subtitles', () => ({ languageName: (s: string) => s }));

type Remote = typeof import('../src/services/remoteapi');
let remote: Remote;
let db: typeof import('../src/services/db');
let streaming: typeof import('../src/services/streaming');
let limits: typeof import('../src/services/limits');
let core: typeof import('@tauri-apps/api/core');

const adult = { id: 1, name: 'Ian', color: '#E50914', maturity: 'all', pin: '', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const kid = { id: 2, name: 'Kids', color: '#F5B70A', maturity: 'kids', pin: '', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const locked = { id: 3, name: 'Locked', color: '#2E86DE', maturity: 'all', pin: '4321', daily_limit: 0, bedtime: '', wake_time: '07:00' };
const rated = { ...movie, id: 1, title: 'Grown-up film', certification: 'R' };
const family = { ...movie, id: 2, title: 'Family film', file_path: '/Movies/Family.mp4', certification: 'G' };

const A = { session: 'sessA', device: 'iPhone · Safari' };
const B = { session: 'sessB', device: 'Windows PC · Edge' };
const play = (caller = A, profile = 1, id = 2) => remote.route(caller, 'POST', '/play', {}, { profile, type: 'movie', id });

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  streamCount = 0;
  db = await import('../src/services/db');
  streaming = await import('../src/services/streaming');
  limits = await import('../src/services/limits');
  core = await import('@tauri-apps/api/core');
  const { useLibraryStore } = await import('../src/store/useLibraryStore');
  useLibraryStore.setState({ profiles: [adult, kid, locked] as never, torrents: [] });
  vi.mocked(db.loadLibrary).mockResolvedValue({ movies: [rated, family], series: [], episodes: [] } as never);
  vi.mocked(limits.limitStatus).mockResolvedValue({ blocked: null, remaining: null });
  remote = await import('../src/services/remoteapi');
});

describe('browser API rules', () => {
  it('lets kids profiles play only titles their rating allows', async () => {
    await expect(play(A, 2, 1)).rejects.toMatchObject({ status: 404 });
    await expect(play(A, 2, 2)).resolves.toMatchObject({ token: 'tok1' });
    await expect(play(B, 1, 1)).resolves.toMatchObject({ token: 'tok2' });
  });

  it('only lets the browser that started playback seek or stop it', async () => {
    const { token } = (await play(A)) as { token: string };
    await expect(remote.route(B, 'POST', '/seek', {}, { token, time: 30 })).rejects.toMatchObject({ status: 404 });
    await remote.route(B, 'POST', '/stop', {}, { token });
    expect(streaming.releaseStream).not.toHaveBeenCalledWith(token);
    await expect(remote.route(A, 'POST', '/seek', {}, { token, time: 30 })).resolves.toMatchObject({ url: `/stream/${token}/file` });
    await remote.route(A, 'POST', '/stop', {}, { token });
    expect(streaming.releaseStream).toHaveBeenCalledWith(token);
  });

  it('credits watch time from the real time between reports, not what the browser claims', async () => {
    const { token } = (await play(A)) as { token: string };
    await remote.route(A, 'POST', '/progress', {}, { profile: 1, type: 'movie', id: 2, time: 10, duration: 100, watched: 600, token });
    const credited = vi.mocked(db.logWatchTime).mock.calls[0][2];
    expect(credited).toBeGreaterThan(0);
    expect(credited).toBeLessThanOrEqual(6);

    vi.mocked(db.logWatchTime).mockClear();
    await remote.route(B, 'POST', '/progress', {}, { profile: 1, type: 'movie', id: 2, time: 10, duration: 100, watched: 30, token });
    expect(db.logWatchTime).not.toHaveBeenCalled();
  });

  it('stops playback on the PC when a limit is reached', async () => {
    const { token } = (await play(A)) as { token: string };
    vi.mocked(limits.limitStatus).mockResolvedValue({ blocked: 'bedtime', remaining: null });
    const res = await remote.route(A, 'POST', '/progress', {}, { profile: 1, type: 'movie', id: 2, time: 10, duration: 100, watched: 5, token });
    expect(res).toMatchObject({ blocked: 'It’s bedtime' });
    expect(streaming.releaseStream).toHaveBeenCalledWith(token);
    await expect(remote.route(A, 'POST', '/seek', {}, { token, time: 5 })).rejects.toMatchObject({ status: 404 });
  });

  it('locks a profile after five wrong PINs and expires unlock keys when the PIN changes', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(remote.route(A, 'POST', '/unlock', {}, { profile: 3, pin: '0000' })).rejects.toMatchObject({ status: 403 });
    }
    await expect(remote.route(A, 'POST', '/unlock', {}, { profile: 3, pin: '4321' })).rejects.toMatchObject({ status: 429 });
  }, 10_000);

  it('accepts the right PIN and rejects its key after the PIN changes', async () => {
    const { key } = (await remote.route(A, 'POST', '/unlock', {}, { profile: 3, pin: '4321' })) as { key: string };
    await expect(remote.route(A, 'GET', '/library', { profile: '3', key }, {})).resolves.toBeTruthy();
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState({ profiles: [adult, kid, { ...locked, pin: '9999' }] as never });
    await expect(remote.route(A, 'GET', '/library', { profile: '3', key }, {})).rejects.toMatchObject({ status: 403 });
  });

  it('allows one playback per browser and a few browsers at once', async () => {
    const first = (await play(A)) as { token: string };
    await play(A);
    expect(streaming.releaseStream).toHaveBeenCalledWith(first.token);
    for (let i = 1; i < remote.MAX_REMOTE_STREAMS; i++) await play({ session: `s${i}`, device: 'x' });
    await expect(play({ session: 'one-too-many', device: 'x' })).rejects.toMatchObject({ status: 429 });
  });

  it('ends playback when a browser is signed out', async () => {
    const { token } = (await play(A)) as { token: string };
    remote.endRemoteSession('sessA');
    expect(streaming.releaseStream).toHaveBeenCalledWith(token);
  });

  it('never sends internal error details to the browser', async () => {
    const event = await import('@tauri-apps/api/event');
    await remote.initRemoteApi();
    const handler = vi.mocked(event.listen).mock.calls.find(([name]) => name === 'remote-api')![1] as (e: { payload: unknown }) => Promise<void>;
    vi.mocked(db.loadLibrary).mockRejectedValue(new Error('File not found: C:\\Users\\me\\secret.mkv'));
    await handler({ payload: { id: 7, method: 'GET', path: '/library', query: { profile: '1' }, body: null, session: 'sessA', device: 'x' } });
    const reply = vi.mocked(core.invoke).mock.calls.find(([cmd]) => cmd === 'remote_api_reply')![1] as { status: number; body: string };
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('secret');
  });
});
