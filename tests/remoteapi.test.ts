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
  getDb: vi.fn(),
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
  seekLive: vi.fn(async () => {}),
  toggleFullscreen: vi.fn(async () => true),
}));
vi.mock('../src/services/cast', () => ({ castControl: vi.fn(), castSeek: vi.fn(async () => {}), stopCasting: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false }) }));
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
  // One-row lookups used by /progress.
  vi.mocked(db.getDb).mockResolvedValue({
    select: vi.fn(async (sql: string, [id]: number[]) => {
      if (sql.includes('FROM movies')) return [rated, family].filter((m) => m.id === id).map((m) => ({ certification: m.certification }));
      return [];
    }),
  } as never);
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

  it('checks the rating of just the reported title and patches the desktop rows in place', async () => {
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    const patchProgress = vi.fn();
    const reload = vi.fn(async () => {});
    useLibraryStore.setState({ activeProfile: adult, patchProgress, reload } as never);
    await expect(remote.route(A, 'POST', '/progress', {}, { profile: 2, type: 'movie', id: 1, time: 10, duration: 100 })).rejects.toMatchObject({ status: 404 });
    await expect(remote.route(A, 'POST', '/progress', {}, { profile: 1, type: 'episode', id: 99, time: 10, duration: 100 })).rejects.toMatchObject({ status: 404 });
    expect(db.recordProgress).not.toHaveBeenCalled();
    await remote.route(A, 'POST', '/progress', {}, { profile: 1, type: 'movie', id: 1, time: 40, duration: 100 });
    expect(db.recordProgress).toHaveBeenCalledWith('movie', 1, 40, 100, 1);
    expect(patchProgress).toHaveBeenCalledWith('movie', 1, 40, 100);
    expect(db.loadLibrary).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('releases playback from tabs that stopped reporting so new devices can watch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const tokens: string[] = [];
    for (let i = 0; i < remote.MAX_REMOTE_STREAMS; i++) tokens.push(((await play({ session: `s${i}`, device: 'x' })) as { token: string }).token);
    await expect(play({ session: 'late', device: 'x' })).rejects.toMatchObject({ status: 429 });
    // One tab keeps reporting; the others were abandoned.
    vi.setSystemTime(Date.now() + remote.STREAM_IDLE_MS - 10_000);
    await remote.route({ session: 's0', device: 'x' }, 'POST', '/progress', {}, { profile: 1, type: 'movie', id: 2, time: 10, duration: 100, token: tokens[0] });
    vi.setSystemTime(Date.now() + 20_000);
    await expect(play({ session: 'late', device: 'x' })).resolves.toMatchObject({ token: expect.any(String) });
    for (const t of tokens.slice(1)) expect(streaming.releaseStream).toHaveBeenCalledWith(t);
    expect(streaming.releaseStream).not.toHaveBeenCalledWith(tokens[0]);
    await expect(remote.route({ session: 's0', device: 'x' }, 'POST', '/seek', {}, { token: tokens[0], time: 5 })).resolves.toBeTruthy();
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

describe('phone as a remote for the PC', () => {
  const next = { type: 'episode', id: 9, filePath: '/TV/next.mkv', startTime: 0, label: 'Next' };
  const session = {
    target: { type: 'movie', id: 2, filePath: '/Movies/Family.mp4', startTime: 0, label: 'Family film' },
    itemKey: 'movie-2',
    title: 'Family film',
    subtitle: null,
    overview: null,
    logo: null,
    next,
    nextLabel: 'S1:E2 · Next',
  };
  const playerState = { time: 10, duration: 100, paused: false, eof: false, buffering: false, seeking: false, idle: false, volume: 80, muted: false, speed: 1, sub_delay: 0, audio_delay: 0, gamma: null, loaded: true };
  const tracks = [
    { id: 1, type: 'audio', lang: 'eng', selected: true },
    { id: 2, type: 'audio', lang: 'fra' },
    { id: 5, type: 'sub', lang: 'eng' },
  ];
  let player: typeof import('../src/services/player');
  let toast: ReturnType<typeof vi.fn>;
  const state = (caller = A, query: Record<string, string> = { profile: '1' }) => remote.route(caller, 'GET', '/remote/state', query, {});
  const cmd = (action: string, value?: unknown, profile = 1, caller = A) => remote.route(caller, 'POST', '/remote/command', {}, { profile, action, value });
  const playOnPc = (profile: number, id: number, caller = A) => remote.route(caller, 'POST', '/remote/play', {}, { profile, type: 'movie', id });

  beforeEach(async () => {
    player = await import('../src/services/player');
    toast = vi.fn();
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState({ activeProfile: adult, playerSession: session, playerState, playerTracks: tracks, playerPrompt: null, playerMini: false, cast: null, toast } as never);
  });

  it('reports nothing playing without asking for a profile match', async () => {
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState({ playerSession: null, activeProfile: locked } as never);
    await expect(state({ ...A, pc: 'Living Room PC' })).resolves.toEqual({ active: false, pc: 'Living Room PC' });
  });

  it('shows what plays on the PC with its tracks', async () => {
    const s = (await state({ ...A, pc: 'Den' })) as Record<string, unknown>;
    expect(s).toMatchObject({ active: true, pc: 'Den', source: 'player', title: 'Family film', time: 10, duration: 100, volume: 80, next: 'S1:E2 · Next' });
    expect(s.audioTracks).toHaveLength(2);
    expect(s.subTracks).toEqual([expect.objectContaining({ id: 5, selected: false })]);
  });

  it('refuses browsers on another profile when the PC profile has a PIN', async () => {
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState({ activeProfile: locked } as never);
    await expect(state()).rejects.toMatchObject({ status: 403, message: 'Playing on another profile' });
    await expect(cmd('pause')).rejects.toMatchObject({ status: 403 });
    expect(player.playerSet).not.toHaveBeenCalled();
    // The locked profile itself needs its unlock key.
    await expect(state(A, { profile: '3' })).rejects.toMatchObject({ status: 403, message: 'This profile is locked' });
    const { key } = (await remote.route(A, 'POST', '/unlock', {}, { profile: 3, pin: '4321' })) as { key: string };
    await expect(state(A, { profile: '3', key })).resolves.toMatchObject({ active: true });
  });

  it('routes commands to the desktop player actions', async () => {
    await cmd('toggle');
    expect(player.playerCommand).toHaveBeenLastCalledWith('cycle', 'pause');
    await cmd('seek', 30);
    expect(player.playerCommand).toHaveBeenLastCalledWith('seek', '30.00', 'absolute');
    await cmd('skip', -10);
    expect(player.playerCommand).toHaveBeenLastCalledWith('seek', -10, 'relative');
    await cmd('volume', 150);
    expect(player.playerSet).toHaveBeenLastCalledWith('volume', 100);
    await cmd('mute', true);
    expect(player.playerSet).toHaveBeenLastCalledWith('mute', 'yes');
    await cmd('audio', 2);
    expect(player.playerSet).toHaveBeenLastCalledWith('aid', 2);
    await cmd('subtitle', 0);
    expect(player.playerSet).toHaveBeenLastCalledWith('sid', 'no');
    await expect(cmd('audio', 5)).rejects.toMatchObject({ status: 400 });
    await expect(cmd('seek', 'abc')).rejects.toMatchObject({ status: 400 });
    await cmd('next');
    expect(player.playBuiltin).toHaveBeenCalledWith(next);
    await cmd('fullscreen');
    expect(player.toggleFullscreen).toHaveBeenCalled();
    await cmd('stop');
    expect(player.closeBuiltin).toHaveBeenCalled();
    await expect(cmd('format-disk')).rejects.toMatchObject({ status: 400 });
    // One desktop toast per browser.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('iPhone · Safari is controlling playback', 'info');
  });

  it('won’t resume past a viewing-limit prompt', async () => {
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState({ playerPrompt: 'bedtime' } as never);
    await expect(cmd('play')).rejects.toMatchObject({ status: 403 });
    expect(player.dismissPrompt).not.toHaveBeenCalled();
    useLibraryStore.setState({ playerPrompt: 'still-watching' } as never);
    await cmd('toggle');
    expect(player.dismissPrompt).toHaveBeenCalled();
  });

  it('rate-limits commands per browser', async () => {
    for (let i = 0; i < 40; i++) await cmd('volume', 50);
    await expect(cmd('volume', 50)).rejects.toMatchObject({ status: 429 });
    await expect(cmd('volume', 50, 1, B)).resolves.toEqual({ ok: true });
  });

  it('starts playback on the PC only for the profile open there and within its rating', async () => {
    const { useLibraryStore } = await import('../src/store/useLibraryStore');
    useLibraryStore.setState({ playerSession: null, activeProfile: kid } as never);
    await expect(playOnPc(2, 1)).rejects.toMatchObject({ status: 404 });
    await expect(playOnPc(1, 1)).rejects.toMatchObject({ status: 403 });
    expect(player.play).not.toHaveBeenCalled();
    await expect(playOnPc(2, 2)).resolves.toEqual({ ok: true });
    expect(player.play).toHaveBeenCalledWith(expect.objectContaining({ type: 'movie', id: 2, filePath: '/Movies/Family.mp4' }));
    vi.mocked(limits.limitStatus).mockResolvedValue({ blocked: 'bedtime', remaining: null });
    await expect(playOnPc(2, 2, B)).rejects.toMatchObject({ status: 403, message: 'It’s bedtime' });
    expect(player.play).toHaveBeenCalledTimes(1);
  });
});
