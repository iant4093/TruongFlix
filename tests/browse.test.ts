import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { abortable, browseSource, cancelSourceBrowser, candidateMatches, quickTorrent, searchTorrentReleases, validateSourceUrl } from '../src/services/browse';
import { initiateTorrent, inspectTorrentFilesLive } from '../src/services/torrents';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { BrowseTarget, SourceEvent } from '../src/types/browse';
import type { Profile } from '../src/types/media';
import { torrentStatus } from './fixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('../src/services/db');
vi.mock('../src/services/player', () => ({ play: vi.fn() }));
vi.mock('../src/services/torrents', () => ({
  inspectTorrentFilesLive: vi.fn(), initiateTorrent: vi.fn(), pickDestinationFolder: () => '/Movies',
  playTorrentByHash: vi.fn(), formatBytes: () => '1 GB', canStreamTorrent: (t: { mode: string }) => t.mode === 'stream',
}));
const target: BrowseTarget = { imdbId: 'tt1234567', title: 'Example Film', year: 2024, kind: 'movie', quality: '1080p' };
const item = { id: 5, kind: 'movie' as const, title: target.title, year: target.year, overview: '', poster: null, backdrop: null, voteAverage: 8 };
const row = { id: '1', title: 'Example.Film.2024.1080p.WEB', imdbId: target.imdbId, seeders: 100, size: '1 GB' };
let emit: (e: { payload: SourceEvent }) => void;
let requestId = '';
let sourceRows = [row];
beforeEach(() => {
  vi.resetAllMocks();
  sourceRows = [row];
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState({ activeProfile: { id: 1, name: 'Adult', maturity: 'all' } as Profile });
  vi.mocked(listen).mockImplementation(async (_name, callback) => { emit = callback as typeof emit; return () => {}; });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, string>;
    if (command === 'source_browser_open') {
      requestId = a.requestId;
      queueMicrotask(() => emit({ payload: { requestId, kind: 'results', releases: sourceRows } }));
    }
    if (command === 'source_browser_control' && a.action === 'capture') {
      queueMicrotask(() => emit({ payload: { requestId, kind: 'magnet', releaseId: a.releaseId, magnet: 'magnet:?xt=urn:btih:dummy' } }));
    }
    return undefined as never;
  });
  vi.mocked(inspectTorrentFilesLive).mockResolvedValue({ info_hash: 'abc', name: row.title, total_bytes: 100,
    is_magnet: true, metadata_ready: true, trackers: [], files: [{ index: 0, name: 'Example.Film.2024.1080p.mkv', relative_path: 'Example.Film.2024.1080p.mkv', size: 100, is_video: true }] });
  vi.mocked(initiateTorrent).mockResolvedValue(torrentStatus());
});
afterEach(() => { vi.useRealTimers(); });
const run = (signal = new AbortController().signal) => quickTorrent({ item, target, mode: 'stream', sourceUrl: 'https://source.example', signal, progress: vi.fn() });

describe('Browse transfer lifecycle', () => {
  it('preserves catalog identity and verified file selection when starting', async () => {
    await run();
    expect(initiateTorrent).toHaveBeenCalledWith(expect.objectContaining({ match: item, onlyFiles: [0], mode: 'stream', playImmediately: true }));
  });
  it('ignores another browser request’s events', async () => {
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'source_browser_open') queueMicrotask(() => emit({ payload: { requestId: 'wrong', kind: 'error', message: 'Wrong source' } }));
      return original(command, args);
    });
    await run(); expect(initiateTorrent).toHaveBeenCalledOnce();
  });
  it('does not start a transfer when canceled while metadata resolves', async () => {
    const controller = new AbortController();
    let finish!: (value: Awaited<ReturnType<typeof inspectTorrentFilesLive>>) => void;
    vi.mocked(inspectTorrentFilesLive).mockImplementation(() => new Promise((r) => { finish = r; }));
    const running = run(controller.signal);
    await vi.waitFor(() => expect(inspectTorrentFilesLive).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    finish({ info_hash: 'abc', name: row.title, metadata_ready: true, is_magnet: true, total_bytes: 1, files: [], trackers: [] });
    await Promise.resolve(); expect(initiateTorrent).not.toHaveBeenCalled();
  });
  it('cancels when the profile changes during metadata resolution', async () => {
    vi.mocked(inspectTorrentFilesLive).mockImplementation(async () => {
      useLibraryStore.setState({ activeProfile: { id: 2, name: 'Child', maturity: 'kids' } as Profile });
      return { info_hash: 'abc', name: row.title, total_bytes: 1, metadata_ready: true, is_magnet: true, files: [], trackers: [] };
    });
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(initiateTorrent).not.toHaveBeenCalled();
  });
  it('rejects unavailable metadata without starting a payload download', async () => {
    vi.mocked(inspectTorrentFilesLive).mockResolvedValue({ info_hash: 'abc', name: row.title, total_bytes: 0, metadata_ready: false, is_magnet: true, files: [], trackers: [] });
    await expect(run()).rejects.toThrow('No verified release');
    expect(initiateTorrent).not.toHaveBeenCalled();
  });
  it('does not relabel an already active transfer or start it again', async () => {
    useLibraryStore.setState({ torrents: [{ infoHash: 'ABC' }] as never });
    await run(); expect(initiateTorrent).not.toHaveBeenCalled();
  });
  it('cancels a pending inspection immediately and ignores its later result', async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise<string>(() => {}), controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('source and advertised candidate filtering', () => {
  it('requires public HTTPS without embedded credentials', () => {
    expect(validateSourceUrl('https://source.example/browse/?q=test')).toBe('https://source.example');
    for (const url of ['http://source.example', 'file:///etc/passwd', 'https://user:pass@source.example', 'https://localhost']) expect(() => validateSourceUrl(url)).toThrow();
  });
  it('does not substitute quality, episode or playlist identity', () => {
    expect(candidateMatches(target, row)).toBe(true);
    expect(candidateMatches(target, { ...row, title: 'Example.Film.2024.1080i' })).toBe(false);
    expect(candidateMatches(target, { ...row, imdbId: 'tt0000000' })).toBe(false);
    const fromUhd = { ...row, title: 'Example.Film.2024.1080p.UHD.BluRay' };
    expect(candidateMatches(target, fromUhd)).toBe(true);
    expect(candidateMatches({ ...target, quality: '4K' }, fromUhd)).toBe(false);
    const episode = { ...target, kind: 'episode' as const, season: 1, episode: 3 };
    expect(candidateMatches(episode, { ...row, title: 'Example.S01E030.1080p' })).toBe(false);
    expect(candidateMatches(episode, { ...row, title: 'Example.S01E03E04.1080p' })).toBe(false);
    expect(candidateMatches(episode, { ...row, title: 'Example.S01E03.1080p' })).toBe(true);
  });
});

it('tries reported seed counts in order and bounds metadata attempts', async () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({ ...row, id: String(i + 1), seeders: i + 1 }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, string>;
    if (command === 'source_browser_open') {
      requestId = a.requestId;
      queueMicrotask(() => emit({ payload: { requestId, kind: 'results', releases: candidates } }));
    }
    if (command === 'source_browser_control' && a.action === 'capture') queueMicrotask(() => emit({ payload: { requestId, kind: 'magnet', releaseId: a.releaseId, magnet: `magnet:?dn=${a.releaseId}` } }));
    return undefined as never;
  });
  vi.mocked(inspectTorrentFilesLive).mockResolvedValue({ info_hash: 'abc', name: row.title, total_bytes: 0, metadata_ready: false, is_magnet: true, files: [], trackers: [] });
  await expect(run()).rejects.toThrow('No verified release');
  expect(inspectTorrentFilesLive).toHaveBeenCalledTimes(6);
  const captures = vi.mocked(invoke).mock.calls.filter(([command, args]) => command === 'source_browser_control' && (args as { action: string }).action === 'capture');
  expect(captures.map(([, args]) => (args as { releaseId: string }).releaseId)).toEqual(['12', '11', '10', '9', '8', '7']);
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('ranks and deduplicates the top five advertised releases across source pages without inspecting files', async () => {
  const firstPage = [
    { ...row, id: '1', seeders: 15 },
    ...Array.from({ length: 49 }, (_, i) => ({ ...row, id: String(100 + i), title: 'Example.Film.2024.2160p.WEB', seeders: 500 })),
  ];
  const secondPage = [
    ...[90, 10, 30, 70, 40, 50].map((seeders, i) => ({ ...row, id: String(i + 2), seeders })),
    { ...row, id: '1', seeders: 900 },
    { ...row, id: '8', imdbId: 'tt0000000', seeders: 1_000 },
    { ...row, id: '9', seeders: null },
  ];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, string>;
    if (command === 'source_browser_open') {
      requestId = a.requestId;
      queueMicrotask(() => emit({ payload: { requestId, kind: 'results', page: 1, releases: firstPage } }));
    }
    if (command === 'source_browser_control' && a.action === 'page') queueMicrotask(() => {
      emit({ payload: { requestId, kind: 'results', page: 1, releases: firstPage } });
      emit({ payload: { requestId, kind: 'results', page: 2, releases: secondPage } });
    });
    return undefined as never;
  });
  const releases = await searchTorrentReleases({ target, sourceUrl: 'https://source.example', signal: new AbortController().signal, progress: vi.fn() });
  expect(releases.map(({ id, seeders }) => [id, seeders])).toEqual([
    ['2', 90], ['5', 70], ['7', 50], ['6', 40], ['4', 30],
  ]);
  expect(inspectTorrentFilesLive).not.toHaveBeenCalled();
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('finds the chosen release even when its seed ranking moves it to another page', async () => {
  const chosen = { ...row, id: '3', seeders: 10 };
  sourceRows = Array.from({ length: 50 }, (_, i) => ({ ...row, id: String(10 + i) }));
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'source_browser_control' && (args as { action: string }).action === 'page') {
      queueMicrotask(() => emit({ payload: { requestId, kind: 'results', page: 2, releases: [row, chosen] } }));
    }
    return original(command, args);
  });
  await quickTorrent({ item, target, mode: 'download', release: chosen, sourceUrl: 'https://source.example', signal: new AbortController().signal, progress: vi.fn() });
  expect(vi.mocked(invoke).mock.calls.filter(([command, args]) => command === 'source_browser_control'
    && (args as { action: string }).action === 'capture')).toEqual([
    ['source_browser_control', expect.objectContaining({ releaseId: chosen.id })],
  ]);
  expect(initiateTorrent).toHaveBeenCalledOnce();
  expect(initiateTorrent).toHaveBeenCalledWith(expect.objectContaining({ match: item, mode: 'download', onlyFiles: [0] }));
});

it('declines a changed release without capturing a replacement', async () => {
  await expect(quickTorrent({ item, target, mode: 'stream', release: { ...row, title: `${row.title}.Changed` },
    sourceUrl: 'https://source.example', signal: new AbortController().signal, progress: vi.fn() })).rejects.toThrow(/release changed/);
  expect(inspectTorrentFilesLive).not.toHaveBeenCalled();
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('dismisses its season confirmation on cancellation without starting a transfer', async () => {
  sourceRows = [{ ...row, title: 'Example.Show.S01.1080p.WEB' }];
  vi.mocked(inspectTorrentFilesLive).mockResolvedValue({ info_hash: 'abc', name: sourceRows[0].title,
    total_bytes: 200, is_magnet: true, metadata_ready: true, trackers: [], files: [1, 2].map((e) => ({
      index: e - 1, name: `Example.Show.S01E0${e}.1080p.mkv`, relative_path: `Example.Show.S01E0${e}.1080p.mkv`, size: 100, is_video: true,
    })) });
  const controller = new AbortController();
  const running = quickTorrent({ item: { ...item, kind: 'tv', title: 'Example Show' },
    target: { ...target, title: 'Example Show', kind: 'season', season: 1, expected: [1, 2], complete: true },
    mode: 'stream', sourceUrl: 'https://source.example', signal: controller.signal, progress: vi.fn() });
  await vi.waitFor(() => expect(useLibraryStore.getState().confirmRequest).not.toBeNull());
  controller.abort();
  await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  expect(useLibraryStore.getState().confirmRequest).toBeNull();
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('hands a manually selected magnet to review with its catalog identity and starts no download', async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === 'source_browser_open') queueMicrotask(() => emit({ payload: { requestId, kind: 'ready' } }));
    return result;
  });
  const selected = vi.fn();
  await browseSource(item, target.imdbId, 'https://source.example', { onSelected: selected });
  const magnet = 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000';
  emit({ payload: { requestId, kind: 'magnet', magnet } });
  await vi.waitFor(() => expect(selected).toHaveBeenCalledOnce());
  expect(useLibraryStore.getState().addTorrentModal).toMatchObject({ open: true, initialSource: magnet, catalogMatch: item });
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('exposes embedded navigation and closes a manual session when its view unmounts', async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === 'source_browser_open') queueMicrotask(() => emit({ payload: { requestId, kind: 'ready' } }));
    return result;
  });
  const controller = new AbortController(); const closed = vi.fn();
  const session = await browseSource(item, target.imdbId, 'https://source.example', { signal: controller.signal, onClosed: closed });
  expect(session.requestId).toBe(requestId);
  for (const action of ['back', 'forward', 'reload'] as const) {
    await session.control(action);
    expect(invoke).toHaveBeenCalledWith('source_browser_control', expect.objectContaining({ requestId, action }));
  }
  controller.abort();
  expect(closed).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenLastCalledWith('source_browser_control', expect.objectContaining({ requestId, action: 'close' }));
  await expect(session.control('reload')).rejects.toMatchObject({ name: 'AbortError' });
  expect(initiateTorrent).not.toHaveBeenCalled();
  cancelSourceBrowser();
  expect(closed).toHaveBeenCalledOnce();
});

it('waits for the embedded view to hide and ignores a selection canceled during that handoff', async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  let hidden!: () => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'source_browser_place') return new Promise<void>((resolve) => { hidden = resolve; }) as never;
    const result = await original(command, args);
    if (command === 'source_browser_open') queueMicrotask(() => emit({ payload: { requestId, kind: 'ready' } }));
    return result;
  });
  const controller = new AbortController(); const selected = vi.fn();
  await browseSource(item, target.imdbId, 'https://source.example', { signal: controller.signal, onSelected: selected });
  emit({ payload: { requestId, kind: 'magnet', magnet: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000' } });
  expect(useLibraryStore.getState().addTorrentModal).toBeNull();
  controller.abort(); hidden();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(selected).not.toHaveBeenCalled();
  expect(useLibraryStore.getState().addTorrentModal).toBeNull();
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('streams an accessible owned version at the requested quality without opening the source', async () => {
  useLibraryStore.setState({ movies: [{ id: 9, tmdb_id: item.id, title: item.title,
    raw_filename: 'Example.Film.2024.1080p.mkv', file_path: '/Movies/example.mkv', media_info: null,
    watched: 0, progress_seconds: 75 }] as never });
  vi.mocked(invoke).mockResolvedValue([true]);
  await run();
  const { play } = await import('../src/services/player');
  expect(play).toHaveBeenCalledWith(expect.objectContaining({ type: 'movie', id: 9, startTime: 75 }));
  expect(invoke).not.toHaveBeenCalledWith('source_browser_open', expect.anything());
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('starts a download with only the verified season files after confirmation', async () => {
  sourceRows = [{ ...row, title: 'Example.Show.S01.1080p.WEB' }];
  vi.mocked(inspectTorrentFilesLive).mockResolvedValue({ info_hash: 'abc', name: sourceRows[0].title,
    total_bytes: 200, is_magnet: true, metadata_ready: true, trackers: [], files: [1, 2].map((e) => ({
      index: e - 1, name: `Example.Show.S01E0${e}.1080p.mkv`, relative_path: `Example.Show.S01E0${e}.1080p.mkv`, size: 100, is_video: true,
    })) });
  const running = quickTorrent({ item: { ...item, kind: 'tv', title: 'Example Show' },
    target: { ...target, title: 'Example Show', kind: 'season', season: 1, expected: [1, 2], complete: true },
    mode: 'download', sourceUrl: 'https://source.example', signal: new AbortController().signal, progress: vi.fn() });
  await vi.waitFor(() => expect(useLibraryStore.getState().confirmRequest).not.toBeNull());
  useLibraryStore.getState().resolveConfirm(true);
  await running;
  expect(initiateTorrent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'download', onlyFiles: [0, 1], destinationRoot: '/Movies', playImmediately: false }));
});

it('ignores a manual browser magnet after the profile selector opens', async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === 'source_browser_open') queueMicrotask(() => emit({ payload: { requestId, kind: 'ready' } }));
    return result;
  });
  await browseSource(item, target.imdbId, 'https://source.example');
  useLibraryStore.setState({ profileGate: 'select' });
  emit({ payload: { requestId, kind: 'magnet', magnet: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000' } });
  expect(useLibraryStore.getState().addTorrentModal).toBeNull();
  expect(initiateTorrent).not.toHaveBeenCalled();
});

it('requests inline verification and resumes without showing the quick-search browser window', async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'source_browser_open') {
      requestId = (args as { requestId: string }).requestId;
      queueMicrotask(() => {
        emit({ payload: { requestId, kind: 'challenge' } });
        emit({ payload: { requestId, kind: 'results', releases: [row] } });
      });
      return undefined as never;
    }
    return original(command, args);
  });
  const verification = vi.fn();
  await quickTorrent({ item, target, mode: 'stream', sourceUrl: 'https://source.example', signal: new AbortController().signal, progress: vi.fn(), verification });
  expect(verification.mock.calls[0][0]).toBe(requestId);
  expect(verification).toHaveBeenLastCalledWith(null);
  expect(initiateTorrent).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalledWith('source_browser_control', expect.objectContaining({ action: 'show' }));
});
