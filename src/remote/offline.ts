/**
 * Saving titles in the browser for watching without a connection to the PC. One download runs at a
 * time; the rest wait in line. Interrupted downloads continue where they stopped.
 */
import { useSyncExternalStore } from 'react';
import type { Quality } from '../lib/quality';
import { api, ApiStatusError } from './api';
import type { RemoteDownload, RemoteDownloadStatus } from './types';
import {
  CHUNK_BYTES,
  INTERRUPTED,
  isQuotaError,
  mergeProgress,
  newItem,
  nextRange,
  parseContentRange,
  progressKey,
  retryDelay,
  spaceProblem,
  STORAGE_FULL,
  type OfflineItem,
  type PendingProgress,
  type SpaceEstimate,
} from './offlineLogic';
import { idbStore, type OfflineStore } from './offlineStore';
import { errorMessage } from '../lib/errors';
import { PROFILE_LOCKED } from './types';

const RETRIES = 5;
const STATUS_POLL_MS = 2000;
/** Keeps the PC from ending the download while chunks are fetched. */
const KEEPALIVE_MS = 15_000;

export interface EngineDeps {
  store: OfflineStore;
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  estimate: () => Promise<SpaceEstimate | null>;
  sleep: (ms: number) => Promise<void>;
  onChange: (item: OfflineItem) => void;
  signal: AbortSignal;
  chunkBytes?: number;
}

const abortError = () => new DOMException('Download paused', 'AbortError');
export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/**
 * Runs one download to the end (or until it pauses or fails) and returns the item's final state.
 * Throws an AbortError when `signal` is aborted.
 */
export async function runDownload(start: OfflineItem, deps: EngineDeps): Promise<OfflineItem> {
  const { store, signal } = deps;
  let item: OfflineItem = { ...start, state: 'preparing', prepare: 0, error: null };
  const save = async (patch: Partial<OfflineItem>) => {
    item = { ...item, ...patch };
    await store.put(item);
    deps.onChange(item);
    return item;
  };
  const check = () => {
    if (signal.aborted) throw abortError();
  };
  await save({});

  let dl: RemoteDownload;
  // A conversion kept from before the pause, if the PC still has it (it lets one go after 30 idle minutes).
  const kept = item.mode === 'convert' && item.bytes > 0 && item.job ? item.job : null;
  const still = kept
    ? await deps.api<RemoteDownloadStatus>(`/download/status?token=${encodeURIComponent(kept.token)}`).catch(() => null)
    : null;
  const reused = !!kept && !!still && still.state !== 'failed' && !!item.quality;
  try {
    dl = reused
      ? {
          token: kept!.token,
          url: kept!.url,
          mode: 'convert',
          mime: item.mime,
          quality: item.quality!,
          itemKey: item.itemKey,
          title: item.title,
          subtitle: item.subtitle,
          duration: item.duration,
          estimate: null,
          chapters: item.chapters,
          segments: item.segments,
          stinger: item.stinger,
        }
      : await deps.api<RemoteDownload>('/download', {
          body: { profile: item.profile, key: item.profileKey, type: item.type, id: item.mediaId, quality: item.requested },
        });
  } catch (e) {
    check();
    // A PIN profile whose unlock expired (the PC restarted, or 12 hours passed) waits for the PIN:
    // it used to fail for good, and every queued episode after it too.
    if (e instanceof ApiStatusError && e.status === 403 && e.message === PROFILE_LOCKED) return save({ state: 'paused', error: LOCKED_WAIT });
    return save({ state: e instanceof ApiStatusError ? 'failed' : 'paused', error: e instanceof ApiStatusError ? e.message : INTERRUPTED });
  }
  // `stop` ends the PC's side for good (done, failed); `hold` is for a pause that will be resumed: a
  // conversion is kept for the next try (a plain file costs the PC nothing to start again).
  const stop = () => void deps.api('/stop', { body: { token: dl.token } }).catch(() => {});
  const hold = () => (dl.mode === 'convert' ? undefined : stop());
  try {
    // Stored bytes are only kept for the same original file or the same conversion; a new
    // conversion may differ.
    const keep = item.bytes > 0 && ((item.mode === 'file' && dl.mode === 'file') || reused);
    if (!keep) {
      await store.clearChunks(item.id);
      item = { ...item, bytes: 0, chunks: 0, total: null };
    }
    await save({
      job: dl.mode === 'convert' ? { token: dl.token, url: dl.url } : null,
      mode: dl.mode,
      mime: dl.mime,
      quality: dl.quality,
      itemKey: dl.itemKey ?? item.itemKey,
      title: dl.title,
      subtitle: dl.subtitle,
      duration: dl.duration,
      chapters: dl.chapters,
      segments: dl.segments,
      stinger: dl.stinger,
    });
    const roomFor = async (bytes: number) => spaceProblem(await deps.estimate().catch(() => null), bytes);
    const early = dl.estimate ? await roomFor(dl.estimate - item.bytes) : null;
    if (early) {
      stop();
      return save({ state: 'failed', error: early });
    }

    if (dl.mode === 'convert') {
      let misses = 0;
      for (;;) {
        check();
        let st: RemoteDownloadStatus;
        try {
          st = await deps.api<RemoteDownloadStatus>(`/download/status?token=${encodeURIComponent(dl.token)}`);
          misses = 0;
        } catch (e) {
          check();
          // The PC ended the conversion (e.g. it went idle while the phone slept): resumable, not failed.
          const gone = e instanceof ApiStatusError && e.status === 404;
          if ((e instanceof ApiStatusError && !gone) || ++misses > RETRIES || gone) {
            if (e instanceof ApiStatusError) stop();
            else hold();
            return save({ state: 'paused', error: e instanceof ApiStatusError && !gone ? e.message : INTERRUPTED, ...(gone ? { job: null } : {}) });
          }
          await deps.sleep(retryDelay(misses));
          continue;
        }
        if (st.state === 'failed') {
          stop();
          return save({ state: 'failed', error: st.error ?? 'The PC couldn’t convert this video.' });
        }
        if (st.state === 'ready') break;
        await save({ prepare: st.progress });
        await deps.sleep(STATUS_POLL_MS);
      }
    }

    await save({ state: 'downloading', prepare: 1 });
    let attempts = 0;
    let lastPing = Date.now();
    for (let range = nextRange(item.bytes, item.total, deps.chunkBytes); range; range = nextRange(item.bytes, item.total, deps.chunkBytes)) {
      check();
      try {
        const res = await deps.fetch(dl.url, { headers: { Range: `bytes=${range.start}-${range.end}` }, signal });
        if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const got = parseContentRange(res.headers.get('Content-Range'));
        if (!got || got.start !== range.start || got.total == null) throw new Error('Bad range');
        if (item.total != null && got.total !== item.total) {
          // The file on the PC changed: start over.
          await store.clearChunks(item.id);
          await save({ bytes: 0, chunks: 0, total: null });
          continue;
        }
        if (item.total == null) {
          const late = await roomFor(got.total - item.bytes);
          if (late) {
            stop();
            return save({ state: 'failed', error: late });
          }
          item = { ...item, total: got.total };
        }
        const data = await res.blob();
        if (data.size !== got.end - got.start + 1) throw new Error('Short read');
        check();
        item = { ...item, bytes: item.bytes + data.size, chunks: item.chunks + 1 };
        await store.putChunk(item, item.chunks - 1, data);
        deps.onChange(item);
        attempts = 0;
        if (Date.now() - lastPing > KEEPALIVE_MS) {
          lastPing = Date.now();
          void deps.api(`/download/status?token=${encodeURIComponent(dl.token)}`).catch(() => {});
        }
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw abortError();
        if (isQuotaError(e)) {
          // putChunk failed as a whole, so the stored item still has the previous count.
          const stored = (await store.get(item.id)) ?? item;
          item = { ...stored };
          hold();
          return save({ state: 'paused', error: STORAGE_FULL });
        }
        if (++attempts > RETRIES) {
          hold();
          return save({ state: 'paused', error: INTERRUPTED });
        }
        await deps.sleep(retryDelay(attempts));
      }
    }
    stop();
    return save({ state: 'done', error: null, job: null });
  } catch (e) {
    if (isAbort(e)) {
      hold(); // paused by the user: resumed later from the same conversion
      throw e;
    }
    stop();
    return save({ state: 'failed', error: errorMessage(e), job: null });
  }
}

// ---------------------------------------------------------------------------
// The browser's download list
// ---------------------------------------------------------------------------

let store: OfflineStore | null = null;
const getStore = () => (store ??= idbStore());
let items: OfflineItem[] = [];
const LOCKED_WAIT = 'Waiting for this profile’s PIN: open it again to continue';
const listeners = new Set<() => void>();
let current: { id: string; ctrl: AbortController; finished: Promise<void> } | null = null;

/** Whether a download is running right now (a reload would cut it off). */
export const downloading = () => current != null;
let started = false;

function emit() {
  for (const l of listeners) l();
}

function setItem(item: OfflineItem | null, id = item?.id) {
  items = item ? (items.some((i) => i.id === id) ? items.map((i) => (i.id === id ? item : i)) : [...items, item]) : items.filter((i) => i.id !== id);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => items;

/** Every saved or saving title in this browser. */
export function useOfflineItems(): OfflineItem[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

async function estimate(): Promise<SpaceEstimate | null> {
  return (await navigator.storage?.estimate?.()) ?? null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pump() {
  if (current) return;
  const next = items.find((i) => i.state === 'queued');
  if (!next) return;
  const ctrl = new AbortController();
  const run = async () => {
    try {
      await runDownload(next, {
        store: getStore(),
        api,
        fetch: (url, init) => fetch(url, init),
        estimate,
        sleep,
        onChange: (i) => {
          if (!ctrl.signal.aborted) setItem(i);
        },
        signal: ctrl.signal,
        chunkBytes: CHUNK_BYTES,
      });
    } catch (e) {
      if (!isAbort(e)) console.warn('[offline]', e);
      const latest = await getStore().get(next.id).catch(() => undefined);
      if (latest && items.some((i) => i.id === next.id)) {
        const paused = { ...latest, state: 'paused' as const, error: null };
        await getStore().put(paused).catch(() => {});
        setItem(paused);
      }
    }
  };
  current = { id: next.id, ctrl, finished: Promise.resolve() };
  current.finished = run().finally(() => {
    current = null;
    pump();
  });
}

/** Loads the list, continues downloads a closed tab interrupted, and sends offline progress. */
export async function initOffline() {
  if (started) return;
  started = true;
  try {
    const stored = await getStore().items();
    items = stored.map((i) => (i.state === 'preparing' || i.state === 'downloading' ? { ...i, state: 'queued' as const } : i));
    await Promise.all(items.filter((i, n) => i.state !== stored[n].state).map((i) => getStore().put(i)));
    emit();
  } catch (e) {
    console.warn('[offline]', e);
  }
  // Interrupted downloads carry on when the connection comes back, and when the app comes back to
  // the front (a locked phone stops them).
  const carryOn = () => {
    void flushProgress();
    for (const i of items) if (i.state === 'paused' && i.error === INTERRUPTED) void resumeDownload(i.id);
  };
  window.addEventListener('online', carryOn);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') carryOn();
  });
  void flushProgress();
  pump();
}

/** Adds a title to the download line. */
export async function saveForOffline(
  who: { id: number; key?: string },
  target: { type: 'movie' | 'episode'; id: number; title: string; subtitle: string | null; itemKey: string | null },
  requested: Partial<Quality>,
) {
  void navigator.storage?.persist?.().catch(() => false);
  const item = newItem({ profile: who.id, profileKey: who.key, type: target.type, mediaId: target.id, title: target.title, subtitle: target.subtitle, itemKey: target.itemKey, requested });
  const existing = items.find((i) => i.id === item.id);
  if (existing && existing.state !== 'failed') return existing;
  if (existing) await deleteDownload(existing.id);
  await getStore().put(item);
  setItem(item);
  pump();
  return item;
}

export async function pauseDownload(id: string) {
  if (current?.id === id) {
    current.ctrl.abort();
    await current.finished;
    return;
  }
  const item = items.find((i) => i.id === id);
  if (item?.state === 'queued') {
    const paused = { ...item, state: 'paused' as const };
    await getStore().put(paused);
    setItem(paused);
  }
}

export async function resumeDownload(id: string) {
  const item = items.find((i) => i.id === id);
  if (!item || item.state === 'done' || current?.id === id) return;
  const queued = { ...item, state: 'queued' as const, error: null };
  await getStore().put(queued);
  setItem(queued);
  pump();
}

export async function deleteDownload(id: string) {
  // A conversion kept for resuming isn't needed any more.
  const job = items.find((i) => i.id === id)?.job;
  if (job) void api('/stop', { body: { token: job.token } }).catch(() => {});
  if (current?.id === id) {
    const run = current;
    run.ctrl.abort();
    setItem(null, id);
    await run.finished;
  }
  await getStore().remove(id);
  setItem(null, id);
}

/** A playable URL for a saved title (revoke it when done). */
export async function offlineUrl(item: OfflineItem): Promise<string> {
  const parts = await getStore().chunks(item.id);
  return URL.createObjectURL(new Blob(parts, { type: item.mime }));
}

export async function savePosition(id: string, position: number) {
  const item = items.find((i) => i.id === id) ?? (await getStore().get(id));
  if (!item) return;
  const next = { ...item, position };
  await getStore().put(next);
  setItem(next);
}

let pendingQueue: PendingProgress[] = [];

/** Remembers progress to send when the PC can be reached again. */
export async function queueProgress(p: Omit<PendingProgress, 'key' | 'at'>) {
  const entry: PendingProgress = { ...p, key: progressKey(p), at: Date.now() };
  pendingQueue = mergeProgress(pendingQueue, entry);
  await getStore().putPending(entry).catch(() => {});
}

let flushing = false;

/** Points saved progress for a PIN profile at its new unlock, after the PIN is entered again. */
export async function rekeyProgress(profile: number, profileKey: string | undefined) {
  const stored = await getStore().pending().catch(() => [] as PendingProgress[]);
  for (const p of stored) pendingQueue = mergeProgress(pendingQueue, p);
  for (const p of pendingQueue) {
    if (p.profile !== profile || p.profileKey === profileKey) continue;
    p.profileKey = profileKey;
    await getStore().putPending(p).catch(() => {});
  }
  // Downloads for this profile use the new unlock too; the ones waiting for it carry on.
  let woke = false;
  for (const item of items) {
    if (item.profile !== profile || item.state === 'done' || item.profileKey === profileKey) continue;
    const waiting = item.state === 'paused' && item.error === LOCKED_WAIT;
    const next = { ...item, profileKey, ...(waiting ? { state: 'queued' as const, error: null } : {}) };
    await getStore().put(next).catch(() => {});
    setItem(next);
    woke ||= waiting;
  }
  if (woke) pump();
}

/**
 * Sends offline progress to the PC. Entries the PC refuses for good (a removed title) are dropped;
 * a PIN profile whose unlock expired keeps its progress until the PIN is entered again.
 */
export async function flushProgress() {
  if (flushing) return;
  flushing = true;
  try {
    const stored = await getStore().pending().catch(() => [] as PendingProgress[]);
    for (const p of stored) pendingQueue = mergeProgress(pendingQueue, p);
    for (const p of [...pendingQueue].sort((a, b) => a.at - b.at)) {
      try {
        await api('/progress', { body: { profile: p.profile, key: p.profileKey, type: p.type, id: p.id, time: p.time, duration: p.duration, at: p.at } });
      } catch (e) {
        if (!(e instanceof ApiStatusError) || e.status === 429 || e.status >= 500) break; // still offline, or busy
        if (e.status === 403 && e.message === PROFILE_LOCKED) continue; // kept: sent once unlocked again
      }
      pendingQueue = pendingQueue.filter((x) => x.key !== p.key);
      await getStore().removePending(p.key).catch(() => {});
    }
  } finally {
    flushing = false;
  }
}

/** Space used and available for this site, when the browser says. */
export async function storageInfo(): Promise<SpaceEstimate | null> {
  return estimate().catch(() => null);
}

/** Tests: swap the store and clear state. */
export function _resetOffline(s: OfflineStore | null) {
  store = s;
  items = [];
  current = null;
  started = false;
  pendingQueue = [];
}
