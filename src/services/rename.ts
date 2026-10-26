import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import type { FileMove } from '../types/media';
import * as db from './db';
import { rootFor } from './files';

export interface RenamePlanItem {
  from: string;
  to: string;
  kind: 'movie' | 'episode';
  /** Title shown in the preview, e.g. "Severance · S01E03". */
  label: string;
  itemKey: string;
}

const sep = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');

/** File/folder-safe name: no reserved characters, no trailing dots or spaces (Windows). */
export function safeName(name: string): string {
  return name
    .replace(/:\s*/g, ' - ')
    .replace(/[<>"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

const pad = (n: number) => String(n).padStart(2, '0');
const extOf = (path: string) => path.match(/\.[^./\\]+$/)?.[0] ?? '';
const qualityTag = (resolution: string | null) => (resolution === '4K' ? '2160p' : resolution === 'HD' ? '1080p' : resolution ?? 'version');

/**
 * Plex-style plan for every matched title (optionally only `onlyKey`):
 *   Movies:   <root>/Movie (Year)/Movie (Year).ext   (" - 2160p" suffix when several versions exist)
 *   Episodes: <root>/Show/Season 01/Show - S01E03.ext
 * Files never leave their media folder. Already-correct files are skipped.
 */
export function planRenames(onlyKey?: string): { plan: RenamePlanItem[]; skipped: string[] } {
  const { movies, series, episodes, settings, allItems } = useLibraryStore.getState();
  const roots = settings.media_directories;
  const plan: RenamePlanItem[] = [];
  const skipped: string[] = [];
  const taken = new Set<string>();

  const add = (item: RenamePlanItem) => {
    if (item.from === item.to) return;
    const key = item.to.toLowerCase();
    if (taken.has(key)) {
      skipped.push(`${item.label}: another file would get the same name`);
      return;
    }
    taken.add(key);
    plan.push(item);
  };

  const byTmdb = new Map<number, typeof movies>();
  for (const m of movies) if (m.tmdb_id) byTmdb.set(m.tmdb_id, [...(byTmdb.get(m.tmdb_id) ?? []), m]);

  for (const m of movies) {
    const item = allItems.find((i) => i.kind === 'movie' && i.versions.some((v) => v.id === m.id));
    if (!item || (onlyKey && item.key !== onlyKey)) continue;
    if (!m.tmdb_id) {
      if (onlyKey) skipped.push(`${m.title}: not matched with TMDB`);
      continue;
    }
    const root = rootFor(m.file_path, roots);
    if (!root) continue;
    const s = sep(m.file_path);
    const base = safeName(m.year ? `${m.title} (${m.year})` : m.title);
    const versions = byTmdb.get(m.tmdb_id) ?? [m];
    const suffix = versions.length > 1 ? ` - ${qualityTag(m.resolution)}` : '';
    add({ from: m.file_path, to: [root, base, `${base}${suffix}${extOf(m.file_path)}`].join(s), kind: 'movie', label: base + suffix, itemKey: item.key });
  }

  for (const e of episodes) {
    const show = series.find((x) => x.id === e.series_id);
    if (!show || (onlyKey && onlyKey !== `tv-${show.id}`)) continue;
    if (show.tmdb_id <= 0) {
      if (onlyKey) skipped.push(`${show.title}: not matched with TMDB`);
      continue;
    }
    const root = rootFor(e.file_path, roots);
    if (!root) continue;
    const s = sep(e.file_path);
    const showName = safeName(show.title);
    const code = `S${pad(e.season_number)}E${pad(e.episode_number)}`;
    add({
      from: e.file_path,
      to: [root, showName, `Season ${pad(e.season_number)}`, `${showName} - ${code}${extOf(e.file_path)}`].join(s),
      kind: 'episode',
      label: `${show.title} · ${code}`,
      itemKey: `tv-${show.id}`,
    });
  }
  return { plan, skipped };
}

interface MoveResult {
  applied: FileMove[];
  errors: string[];
}

/** Renames files (with their subtitles/artwork), updates the library and records an undo batch. */
export async function applyRenames(plan: RenamePlanItem[], label: string) {
  const store = useLibraryStore.getState();
  const roots = store.settings.media_directories;
  const res = await invoke<MoveResult>('apply_moves', { moves: plan.map(({ from, to }) => ({ from, to })), withSidecars: true, roots });
  if (res.applied.length) {
    await db.updateFilePaths(res.applied);
    await db.saveRenameBatch(label, res.applied, roots);
  }
  await store.reload();
  return { renamed: res.applied.filter((m) => plan.some((p) => p.to === m.to)).length, errors: res.errors };
}

/** Moves every file of a rename batch back to where it was. */
export async function undoRename(batch: db.RenameBatch) {
  const applied = JSON.parse(batch.moves) as FileMove[];
  const roots = JSON.parse(batch.roots) as string[];
  const reverse = [...applied].reverse().map((m) => ({ from: m.to, to: m.from }));
  const res = await invoke<MoveResult>('apply_moves', { moves: reverse, withSidecars: false, roots });
  if (res.applied.length) await db.updateFilePaths(res.applied);
  await db.markRenameUndone(batch.id);
  await useLibraryStore.getState().reload();
  return res;
}
