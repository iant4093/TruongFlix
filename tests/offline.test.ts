import { describe, expect, it, vi } from 'vitest';
import { runDownload, type EngineDeps } from '../src/remote/offline';
import {
  INTERRUPTED,
  STORAGE_FULL,
  downloadFraction,
  mergeProgress,
  newItem,
  nextRange,
  parseContentRange,
  retryDelay,
  spaceProblem,
  statusText,
  type OfflineItem,
} from '../src/remote/offlineLogic';
import { memoryStore, type OfflineStore } from '../src/remote/offlineStore';

const BYTES = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
const MB = 1024 * 1024;

function fakePc(opts: { mode?: 'file' | 'convert'; bytes?: Uint8Array; estimate?: number | null; readyAfter?: number; fail?: (n: number) => boolean } = {}) {
  const bytes = opts.bytes ?? BYTES;
  const ranges: string[] = [];
  let polls = 0;
  let fetches = 0;
  const api = vi.fn(async (path: string) => {
    if (path === '/download')
      return {
        token: 't1',
        url: '/stream/t1/download.mp4',
        mode: opts.mode ?? 'file',
        mime: 'video/mp4',
        quality: { res: '720', level: 'high' },
        itemKey: 'movie-2',
        title: 'Family film',
        subtitle: null,
        duration: 100,
        estimate: opts.estimate === undefined ? bytes.length : opts.estimate,
        chapters: [],
        segments: [],
        stinger: null,
      };
    if (path.startsWith('/download/status')) {
      polls++;
      const ready = polls >= (opts.readyAfter ?? 1);
      return { state: ready ? 'ready' : 'converting', progress: ready ? 1 : polls / (opts.readyAfter ?? 1), error: null };
    }
    return { ok: true };
  });
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const range = (init.headers as Record<string, string>).Range;
    ranges.push(range);
    if (opts.fail?.(++fetches)) throw new TypeError('Failed to fetch');
    const [s, e] = range.slice('bytes='.length).split('-').map(Number);
    const end = Math.min(e, bytes.length - 1);
    return new Response(bytes.slice(s, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${s}-${end}/${bytes.length}` } });
  });
  return { api, fetch, ranges, polls: () => polls };
}

function deps(pc: ReturnType<typeof fakePc>, store: OfflineStore, patch: Partial<EngineDeps> = {}): EngineDeps & { changes: OfflineItem[] } {
  const changes: OfflineItem[] = [];
  return {
    store,
    api: pc.api as never,
    fetch: pc.fetch,
    estimate: async () => ({ quota: 10_000 * MB, usage: 0 }),
    sleep: async () => {},
    onChange: (i) => changes.push(i),
    signal: new AbortController().signal,
    chunkBytes: 4,
    changes,
    ...patch,
  };
}

const item = (patch: Partial<OfflineItem> = {}) =>
  ({ ...newItem({ profile: 1, type: 'movie', mediaId: 2, title: 'Family film', subtitle: null, requested: { res: '720', level: 'high' } }), ...patch }) as OfflineItem;

async function storedBytes(store: OfflineStore, id: string) {
  const parts = await Promise.all((await store.chunks(id)).map(async (b) => new Uint8Array(await b.arrayBuffer())));
  return parts.flatMap((p) => [...p]);
}

describe('saving a title in the browser', () => {
  it('stores the file in ranged chunks and reports progress', async () => {
    const pc = fakePc();
    const store = memoryStore();
    const d = deps(pc, store);
    const done = await runDownload(item(), d);
    expect(done).toMatchObject({ state: 'done', bytes: 10, chunks: 3, total: 10, mode: 'file', quality: { res: '720', level: 'high' } });
    expect(pc.ranges).toEqual(['bytes=0-3', 'bytes=4-7', 'bytes=8-9']);
    expect(await storedBytes(store, done.id)).toEqual([...BYTES]);
    const progress = d.changes.filter((c) => c.state === 'downloading').map((c) => c.bytes);
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(pc.api).toHaveBeenCalledWith('/download', { body: expect.objectContaining({ profile: 1, type: 'movie', id: 2, quality: { res: '720', level: 'high' } }) });
    // The PC's copy is released once the browser has it.
    expect(pc.api).toHaveBeenCalledWith('/stop', { body: { token: 't1' } });
    expect(await store.get(done.id)).toMatchObject({ state: 'done' });
  });

  it('pauses after repeated network errors and continues where it stopped', async () => {
    const store = memoryStore();
    const flaky = fakePc({ fail: (n) => n > 1 });
    const paused = await runDownload(item(), deps(flaky, store));
    expect(paused).toMatchObject({ state: 'paused', error: INTERRUPTED, bytes: 4, chunks: 1 });
    expect(flaky.ranges.length).toBe(1 + 6);

    const healthy = fakePc();
    const done = await runDownload((await store.get(paused.id))!, deps(healthy, store));
    expect(done.state).toBe('done');
    expect(healthy.ranges[0]).toBe('bytes=4-7');
    expect(await storedBytes(store, done.id)).toEqual([...BYTES]);
  });

  it('waits for the PC to convert and never mixes bytes from an earlier conversion', async () => {
    const store = memoryStore();
    const partial = item({ mode: 'convert', bytes: 4, chunks: 1, total: 10 });
    await store.putChunk(partial, 0, new Blob([new Uint8Array([99, 99, 99, 99])]));
    const pc = fakePc({ mode: 'convert', readyAfter: 3 });
    const d = deps(pc, store);
    const done = await runDownload(partial, d);
    expect(done.state).toBe('done');
    expect(pc.polls()).toBeGreaterThanOrEqual(3);
    expect(d.changes.some((c) => c.state === 'preparing' && c.prepare > 0 && c.prepare < 1)).toBe(true);
    expect(pc.ranges[0]).toBe('bytes=0-3');
    expect(await storedBytes(store, done.id)).toEqual([...BYTES]);
  });

  it('refuses a download that won’t fit, before fetching anything', async () => {
    const pc = fakePc({ estimate: 2000 * MB });
    const res = await runDownload(item(), deps(pc, memoryStore(), { estimate: async () => ({ quota: 1000 * MB, usage: 200 * MB }) }));
    expect(res.state).toBe('failed');
    expect(res.error).toMatch(/Not enough storage.*2\.0 GB.*800 MB/);
    expect(pc.fetch).not.toHaveBeenCalled();
    expect(pc.api).toHaveBeenCalledWith('/stop', { body: { token: 't1' } });
  });

  it('pauses with a clear message when the browser runs out of space mid-download', async () => {
    const store = memoryStore({ quotaBytes: 6 });
    const res = await runDownload(item(), deps(fakePc(), store));
    expect(res).toMatchObject({ state: 'paused', error: STORAGE_FULL, bytes: 4, chunks: 1 });
    expect(store.stored()).toBe(4);
  });

  it('starts over when the file on the PC changed', async () => {
    const store = memoryStore();
    const old = item({ mode: 'file', bytes: 4, chunks: 1, total: 12 });
    await store.putChunk(old, 0, new Blob([new Uint8Array([1, 2, 3, 4])]));
    const pc = fakePc();
    const done = await runDownload(old, deps(pc, store));
    expect(pc.ranges[0]).toBe('bytes=4-7');
    expect(pc.ranges[1]).toBe('bytes=0-3');
    expect(done).toMatchObject({ state: 'done', total: 10, bytes: 10 });
    expect(await storedBytes(store, done.id)).toEqual([...BYTES]);
  });

  it('stops when paused', async () => {
    const ctrl = new AbortController();
    const pc = fakePc();
    pc.fetch.mockImplementationOnce(async () => {
      ctrl.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(runDownload(item(), deps(pc, memoryStore(), { signal: ctrl.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('shows refusals from the PC', async () => {
    const { ApiStatusError } = await import('../src/remote/api');
    const pc = fakePc();
    pc.api.mockImplementationOnce(async () => {
      throw new ApiStatusError(403, 'It’s bedtime');
    });
    await expect(runDownload(item(), deps(pc, memoryStore()))).resolves.toMatchObject({ state: 'failed', error: 'It’s bedtime' });
  });
});

describe('offline helpers', () => {
  it('reads byte ranges', () => {
    expect(parseContentRange('bytes 0-99/1234')).toEqual({ start: 0, end: 99, total: 1234 });
    expect(parseContentRange('bytes 5-9/*')).toEqual({ start: 5, end: 9, total: null });
    expect(parseContentRange('bytes 9-5/10')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
    expect(nextRange(0, null, 8)).toEqual({ start: 0, end: 7 });
    expect(nextRange(8, 10, 8)).toEqual({ start: 8, end: 9 });
    expect(nextRange(10, 10, 8)).toBeNull();
  });

  it('checks free space with a margin', () => {
    expect(spaceProblem(null, 10 * MB)).toBeNull();
    expect(spaceProblem({ quota: 1000 * MB, usage: 0 }, 900 * MB)).toBeNull();
    expect(spaceProblem({ quota: 1000 * MB, usage: 0 }, 990 * MB)).toMatch(/Not enough storage/);
    expect(spaceProblem({ quota: 1000 * MB, usage: 2000 * MB }, 1)).toMatch(/0 B is free/);
  });

  it('keeps the latest offline position per title', () => {
    const p = (time: number, id = 2) => ({ key: `1:movie:${id}`, profile: 1, type: 'movie' as const, id, time, duration: 100, at: time });
    expect(mergeProgress(mergeProgress([p(10)], p(3, 5)), p(40)).map((x) => [x.id, x.time])).toEqual([
      [5, 3],
      [2, 40],
    ]);
    expect([1, 2, 3, 9].map(retryDelay)).toEqual([1000, 2000, 4000, 30000]);
  });

  it('describes each state', () => {
    expect(statusText(item({ state: 'preparing', prepare: 0.42 }))).toBe('Preparing on your PC · 42%');
    expect(statusText(item({ state: 'downloading', bytes: 25, total: 100 }))).toBe('Downloading · 25%');
    expect(statusText(item({ state: 'done', total: 3 * MB }))).toBe('3 MB');
    expect(statusText(item({ state: 'paused', error: STORAGE_FULL }))).toBe(STORAGE_FULL);
    expect(downloadFraction(item({ state: 'queued' }))).toBe(0);
  });
});

describe('progress saved offline', () => {
  it('keeps a locked profile’s progress until its PIN is entered again', async () => {
    const { _resetOffline, flushProgress, queueProgress, rekeyProgress } = await import('../src/remote/offline');
    const store = memoryStore();
    _resetOffline(store);
    const sent: unknown[] = [];
    let unlocked = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.key !== 'new' || !unlocked) return new Response(JSON.stringify({ error: 'This profile is locked' }), { status: 403 });
      sent.push(body);
      return new Response('{}', { status: 200 });
    }));
    try {
      await queueProgress({ profile: 3, profileKey: 'old', type: 'movie', id: 2, time: 60, duration: 100 });
      await flushProgress();
      expect(await store.pending()).toHaveLength(1);
      unlocked = true;
      await rekeyProgress(3, 'new');
      await flushProgress();
      expect(sent).toEqual([expect.objectContaining({ profile: 3, key: 'new', time: 60 })]);
      expect(await store.pending()).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      _resetOffline(null);
    }
  });
});
