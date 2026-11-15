/**
 * Where saved titles live in the browser: IndexedDB, which (unlike service workers or OPFS) also
 * works on a plain-http home-network address. Bytes are stored as numbered Blob chunks.
 */
import type { OfflineItem, PendingProgress } from './offlineLogic';

export interface OfflineStore {
  items(): Promise<OfflineItem[]>;
  get(id: string): Promise<OfflineItem | undefined>;
  put(item: OfflineItem): Promise<void>;
  /** Stores chunk `index` and the updated item in one transaction, so they never disagree. */
  putChunk(item: OfflineItem, index: number, data: Blob): Promise<void>;
  /** All chunks of an item, in order. */
  chunks(id: string): Promise<Blob[]>;
  clearChunks(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  pending(): Promise<PendingProgress[]>;
  putPending(p: PendingProgress): Promise<void>;
  removePending(key: string): Promise<void>;
}

const DB_NAME = 'truongflix-offline';
const ITEMS = 'items';
const CHUNKS = 'chunks';
const PROGRESS = 'progress';

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Aborted', 'AbortError'));
  });

const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

export function idbStore(factory: IDBFactory = indexedDB): OfflineStore {
  let opening: Promise<IDBDatabase> | null = null;
  const db = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(ITEMS)) d.createObjectStore(ITEMS, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(CHUNKS)) d.createObjectStore(CHUNKS, { keyPath: ['item', 'index'] });
        if (!d.objectStoreNames.contains(PROGRESS)) d.createObjectStore(PROGRESS, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opening = null;
        reject(req.error ?? new Error('This browser can’t save downloads'));
      };
    }));

  async function write(stores: string[], fn: (tx: IDBTransaction) => void) {
    const tx = (await db()).transaction(stores, 'readwrite');
    fn(tx);
    await finished(tx);
  }

  return {
    async items() {
      return done((await db()).transaction(ITEMS).objectStore(ITEMS).getAll() as IDBRequest<OfflineItem[]>);
    },
    async get(id) {
      return done((await db()).transaction(ITEMS).objectStore(ITEMS).get(id) as IDBRequest<OfflineItem | undefined>);
    },
    put: (item) => write([ITEMS], (tx) => tx.objectStore(ITEMS).put(item)),
    putChunk: (item, index, data) =>
      write([ITEMS, CHUNKS], (tx) => {
        tx.objectStore(CHUNKS).put({ item: item.id, index, data });
        tx.objectStore(ITEMS).put(item);
      }),
    async chunks(id) {
      const rows = await done((await db()).transaction(CHUNKS).objectStore(CHUNKS).getAll(chunkRange(id)) as IDBRequest<{ index: number; data: Blob }[]>);
      return rows.sort((a, b) => a.index - b.index).map((r) => r.data);
    },
    clearChunks: (id) => write([CHUNKS], (tx) => tx.objectStore(CHUNKS).delete(chunkRange(id))),
    remove: (id) =>
      write([ITEMS, CHUNKS], (tx) => {
        tx.objectStore(CHUNKS).delete(chunkRange(id));
        tx.objectStore(ITEMS).delete(id);
      }),
    async pending() {
      return done((await db()).transaction(PROGRESS).objectStore(PROGRESS).getAll() as IDBRequest<PendingProgress[]>);
    },
    putPending: (p) => write([PROGRESS], (tx) => tx.objectStore(PROGRESS).put(p)),
    removePending: (key) => write([PROGRESS], (tx) => tx.objectStore(PROGRESS).delete(key)),
  };
}

/** Same behaviour in memory (tests, and browsers where IndexedDB is unavailable). */
export function memoryStore(opts: { quotaBytes?: number } = {}): OfflineStore & { stored(): number } {
  const items = new Map<string, OfflineItem>();
  const chunks = new Map<string, Map<number, Blob>>();
  const pending = new Map<string, PendingProgress>();
  const stored = () => [...chunks.values()].reduce((n, m) => n + [...m.values()].reduce((s, b) => s + b.size, 0), 0);
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    stored,
    async items() {
      return [...items.values()].map(copy);
    },
    async get(id) {
      const v = items.get(id);
      return v && copy(v);
    },
    async put(item) {
      items.set(item.id, copy(item));
    },
    async putChunk(item, index, data) {
      if (opts.quotaBytes != null && stored() + data.size > opts.quotaBytes) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      const m = chunks.get(item.id) ?? new Map<number, Blob>();
      m.set(index, data);
      chunks.set(item.id, m);
      items.set(item.id, copy(item));
    },
    async chunks(id) {
      return [...(chunks.get(id) ?? new Map<number, Blob>()).entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    },
    async clearChunks(id) {
      chunks.delete(id);
    },
    async remove(id) {
      chunks.delete(id);
      items.delete(id);
    },
    async pending() {
      return [...pending.values()].map(copy);
    },
    async putPending(p) {
      pending.set(p.key, copy(p));
    },
    async removePending(key) {
      pending.delete(key);
    },
  };
}
