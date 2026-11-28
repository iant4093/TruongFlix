import { invoke } from '@tauri-apps/api/core';
import type Database from '@tauri-apps/plugin-sql';
import { getDb } from './db';

/**
 * Telling "the files in a library folder were deleted" from "the folder isn't the one it was".
 *
 * A folder that's missing (an unplugged drive, an offline share) is skipped by the scans before
 * this. But a folder can also be there and empty without its files being deleted: the empty mount
 * point of an unmounted drive, or another disk on the same drive letter. Each scan notes which
 * folder each library folder is (its disk and its number there, from `folder_ids`), and a folder
 * that lost everything at once is only emptied when it's still that same folder.
 */

export interface FolderId {
  /** The folder's disk and number on it; null when it's missing or the disk gives no numbers. */
  id: string | null;
  /** On the same disk as TruongFlix's own data, which can't be unplugged or swapped. */
  home: boolean;
}

/** Folders with fewer items than this that lose them all, with no way to tell, are emptied. */
const UNSURE_MIN = 20;

const key = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Library folders to leave alone this scan although they're reachable: every item in them vanished
 * at once, and it isn't the same folder they were in (or there's no telling and it had many).
 * `force` is a full rescan the user asked for, which removes them anyway.
 */
export function heldRoots(
  roots: string[],
  had: (root: string) => number,
  lost: (root: string) => number,
  now: Map<string, FolderId>,
  before: Map<string, string>,
  force = false,
): string[] {
  if (force) return [];
  return roots.filter((root) => {
    const n = had(root);
    if (!n || lost(root) < n) return false;
    const id = now.get(root)?.id ?? null;
    const was = before.get(key(root));
    if (id && was) return id !== was; // the same folder, emptied; or another one at its path
    if (id && now.get(root)?.home) return false; // the system disk is always the same disk
    return n >= UNSURE_MIN;
  });
}

/** Which folder each of `roots` is now (unknown for any the check fails on). */
export async function folderIds(roots: string[]): Promise<Map<string, FolderId>> {
  if (!roots.length) return new Map();
  const ids = await invoke<FolderId[]>('folder_ids', { paths: roots }).catch(() => [] as FolderId[]);
  return new Map(roots.map((r, i) => [r, ids?.[i] ?? { id: null, home: false }]));
}

let ready: Promise<Database> | null = null;

/** The table of which folder each library folder was, made on first use. */
function rootsDb(): Promise<Database> {
  if (!ready) {
    ready = (async () => {
      const db = await getDb();
      await db.execute(`CREATE TABLE IF NOT EXISTS library_folders (
        path TEXT PRIMARY KEY,                 -- lower-cased, forward slashes
        folder_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      )`);
      return db;
    })();
    ready.catch(() => (ready = null));
  }
  return ready;
}

/** For tests: forget the table check (a fresh database). */
export function resetRootsDb() {
  ready = null;
}

/** Which folder each library folder was when its files were last seen (none known: no telling). */
export async function knownFolderIds(): Promise<Map<string, string>> {
  try {
    const db = await rootsDb();
    const rows = await db.select<{ path: string; folder_id: string }[]>('SELECT path, folder_id FROM library_folders');
    return new Map(rows.map((r) => [r.path, r.folder_id]));
  } catch (e) {
    console.warn('[scan] folder ids', e);
    return new Map();
  }
}

/** Notes which folder each of `roots` is, for those whose files were seen this scan. */
export async function rememberFolderIds(roots: string[], now: Map<string, FolderId>, hasFiles: (root: string) => boolean, at = Date.now()) {
  const db = await rootsDb();
  for (const root of roots) {
    const id = now.get(root)?.id;
    if (!id || !hasFiles(root)) continue;
    await db.execute(
      'INSERT INTO library_folders (path, folder_id, seen_at) VALUES ($1, $2, $3) ON CONFLICT(path) DO UPDATE SET folder_id = excluded.folder_id, seen_at = excluded.seen_at',
      [key(root), id, at],
    );
  }
}

/** Like `isUnder` in the scans: ignores slash direction and letter case. */
export const underRoot = (path: string, root: string) => {
  const p = key(path);
  const r = key(root);
  return !!r && (p === r || p.startsWith(`${r}/`));
};
