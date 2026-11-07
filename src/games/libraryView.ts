import { create } from 'zustand';
import type { LibraryGame } from './types';

export type LibraryLayout = 'rows' | 'grid' | 'list';
export type LibrarySort = 'played' | 'added' | 'name' | 'playtime' | 'size';
export type LibraryFilter = 'all' | 'installed' | 'downloading' | 'ready';

export const LIBRARY_SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'played', label: 'Recently played' },
  { value: 'added', label: 'Recently added' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'playtime', label: 'Play time' },
  { value: 'size', label: 'Size' },
];

export const LIBRARY_FILTERS: { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Installed' },
  { value: 'downloading', label: 'Downloading' },
  { value: 'ready', label: 'Ready to install' },
];

/** Times from the library: ISO strings, or SQLite's UTC "YYYY-MM-DD HH:MM:SS". */
export function parseLibraryTime(value: string | null | undefined): number {
  if (!value) return 0;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(iso) || 0;
}

const installed = (g: LibraryGame) => g.status === 'installed' || g.status === 'verify_failed';
const inProgress = (g: LibraryGame) => g.status === 'downloading' || g.status === 'installing' || g.status === 'verifying';

/** `busy` = games with a running install/uninstall job (they count as in progress, not installed). */
export function matchesFilter(game: LibraryGame, filter: LibraryFilter, busy: (id: number) => boolean = () => false): boolean {
  switch (filter) {
    case 'all': return true;
    case 'installed': return installed(game) && !busy(game.id);
    case 'downloading': return inProgress(game) || (busy(game.id) && game.status !== 'uninstalling');
    case 'ready': return game.status === 'downloaded' && !busy(game.id);
  }
}

const byName = (a: LibraryGame, b: LibraryGame) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });

const COMPARE: Record<LibrarySort, (a: LibraryGame, b: LibraryGame) => number> = {
  // Never-played games follow, newest additions first.
  played: (a, b) => parseLibraryTime(b.lastPlayed) - parseLibraryTime(a.lastPlayed) || parseLibraryTime(b.createdAt) - parseLibraryTime(a.createdAt) || byName(a, b),
  added: (a, b) => parseLibraryTime(b.createdAt) - parseLibraryTime(a.createdAt) || byName(a, b),
  name: byName,
  playtime: (a, b) => b.playSeconds - a.playSeconds || byName(a, b),
  // Games with no size on disk yet go last.
  size: (a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || byName(a, b),
};

export function sortGames(games: LibraryGame[], sort: LibrarySort): LibraryGame[] {
  return [...games].sort(COMPARE[sort] ?? COMPARE.played);
}

export function arrangeLibrary(games: LibraryGame[], opts: { sort: LibrarySort; filter: LibraryFilter; query?: string; busy?: (id: number) => boolean }): LibraryGame[] {
  const q = opts.query?.trim().toLowerCase() ?? '';
  return sortGames(games.filter((g) => matchesFilter(g, opts.filter, opts.busy) && (!q || g.title.toLowerCase().includes(q))), opts.sort);
}

export function filterCounts(games: LibraryGame[], busy?: (id: number) => boolean): Record<LibraryFilter, number> {
  const out = { all: 0, installed: 0, downloading: 0, ready: 0 };
  for (const g of games) for (const f of LIBRARY_FILTERS) if (matchesFilter(g, f.value, busy)) out[f.value] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Saved view choice
// ---------------------------------------------------------------------------

export interface LibraryViewPrefs {
  layout: LibraryLayout;
  sort: LibrarySort;
  filter: LibraryFilter;
}

export const DEFAULT_VIEW: LibraryViewPrefs = { layout: 'rows', sort: 'played', filter: 'all' };
const STORAGE_KEY = 'truongflix.games.libraryView';

export function readViewPrefs(raw: string | null): LibraryViewPrefs {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<LibraryViewPrefs>) : {};
    return {
      layout: (['rows', 'grid', 'list'] as const).find((x) => x === v.layout) ?? DEFAULT_VIEW.layout,
      sort: LIBRARY_SORTS.find((x) => x.value === v.sort)?.value ?? DEFAULT_VIEW.sort,
      filter: LIBRARY_FILTERS.find((x) => x.value === v.filter)?.value ?? DEFAULT_VIEW.filter,
    };
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

function load(): LibraryViewPrefs {
  try {
    return readViewPrefs(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

export const useLibraryView = create<LibraryViewPrefs & { set: (patch: Partial<LibraryViewPrefs>) => void }>((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    const { layout, sort, filter } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout, sort, filter }));
    } catch { /* storage unavailable: the choice lasts for this session */ }
  },
}));
