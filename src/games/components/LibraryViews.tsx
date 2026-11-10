import { useMemo, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, Gamepad2, Info, LayoutGrid, List, Loader2, Pause, Play, RotateCcw, Rows3, X } from 'lucide-react';
import { transition } from '../../lib/motion';
import { scrollBehavior } from '../../lib/scroll';
import { formatBytes } from '../../lib/format';
import { pauseTorrent, resumeTorrent } from '../../services/torrents';
import SegmentedControl from '../../components/common/SegmentedControl';
import Dropdown from '../../components/common/Dropdown';
import IconButton from '../../components/common/IconButton';
import ProgressBar from '../../components/common/ProgressBar';
import { Bone, PosterGridSkeleton } from '../../components/common/Skeleton';
import { cancelJob, launchGame, retryDownload, useGamesStore } from '../jobs';
import {
  filterCounts, LIBRARY_FILTERS, LIBRARY_SORTS, parseLibraryTime, useLibraryView,
  type LibraryFilter, type LibraryLayout, type LibrarySort,
} from '../libraryView';
import type { GameCard, LibraryGame } from '../types';
import { hasInstaller, useBusy, useOwnedGame } from './actions';
import type { GameOpeners } from './GameBrowse';
import GameCover from './GameCover';
import { GamePoster, GameRowSkeleton, POSTER_GRID } from './GamePoster';
import { GameBillboardSkeleton } from './GameBillboard';
import { formatPlayTime, gameProgress, gameStatusLabel, isInstalled } from './status';

export const libraryCard = (game: LibraryGame): GameCard =>
  game.detail ?? { slug: game.slug, title: game.title, subtitle: game.subtitle, cover: game.cover, postId: null, date: null };

const LAYOUTS: { value: LibraryLayout; label: string; icon: ReactNode }[] = [
  { value: 'rows', label: 'Rows', icon: <Rows3 aria-hidden="true" className="h-4 w-4" /> },
  { value: 'grid', label: 'Grid', icon: <LayoutGrid aria-hidden="true" className="h-4 w-4" /> },
  { value: 'list', label: 'List', icon: <List aria-hidden="true" className="h-4 w-4" /> },
];

/** Rows / Grid / List switch for the Games sub-nav. */
export function LibraryLayoutToggle() {
  const layout = useLibraryView((s) => s.layout);
  const set = useLibraryView((s) => s.set);
  const empty = useGamesStore((s) => !s.games.length);
  if (empty) return null;
  return (
    <SegmentedControl
      ariaLabel="Library view"
      size="sm"
      value={layout}
      onChange={(next) => { set({ layout: next }); window.scrollTo({ top: 0, behavior: scrollBehavior() }); }}
      options={LAYOUTS.map((l) => ({ value: l.value, icon: l.icon, label: <span className="sr-only">{l.label}</span> }))}
    />
  );
}

/** Loading placeholder matching the saved library view. */
export function GameLibrarySkeleton() {
  const layout = useLibraryView((s) => s.layout);
  if (layout === 'rows') return <><GameBillboardSkeleton /><div className="relative z-10 -mt-32"><GameRowSkeleton /><GameRowSkeleton /></div></>;
  return (
    <section className="min-h-screen px-[4%] pb-16 pt-[148px]">
      <div className="mb-6 flex h-10 items-center"><Bone tone="soft" className="h-8 w-48 rounded" /></div>
      <div className="mb-8 flex gap-2">{[64, 84, 104, 124].map((w) => <Bone key={w} tone="soft" className="h-8 rounded" style={{ width: w }} />)}</div>
      {layout === 'grid' ? <PosterGridSkeleton count={14} className={POSTER_GRID} /> : <ListSkeleton />}
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border border-white/10">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-white/[0.06] px-4 py-3 last:border-0">
          <Bone className="h-16 w-12 rounded" style={{ animationDelay: `${i * 60}ms` }} />
          <div className="flex-1 space-y-2"><Bone className="h-3.5 w-1/3" /><Bone tone="soft" className="h-3 w-1/5" /></div>
          <Bone tone="soft" className="h-8 w-24 rounded" />
        </div>
      ))}
    </div>
  );
}

const chip = (on: boolean) =>
  `inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm transition-colors duration-150 ${on ? 'border-white bg-white text-black' : 'border-white/30 text-nf-secondary hover:border-white/60 hover:text-white'}`;

function Toolbar({ total, shown, query }: { total: number; shown: number; query: string }) {
  const { sort, filter, set } = useLibraryView();
  const games = useGamesStore((s) => s.games);
  const jobs = useGamesStore((s) => s.jobs);
  const counts = useMemo(() => filterCounts(games, (id) => !!jobs[id]), [games, jobs]);
  return (
    <div className="mb-6 space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <h2 className="text-[clamp(1.4rem,2.2vw,2.2rem)] font-semibold leading-tight">
          {query.trim() ? <>Results for “{query.trim()}”</> : 'My Games'}
          <span className="ml-3 align-middle text-base font-normal text-nf-secondary">{shown === total ? total : `${shown} of ${total}`} game{total === 1 ? '' : 's'}</span>
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-nf-secondary">Sort by</span>
          <Dropdown ariaLabel="Sort games" align="right" value={sort} options={LIBRARY_SORTS} onChange={(v: LibrarySort) => set({ sort: v })} className="min-w-[180px]" />
        </div>
      </div>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {LIBRARY_FILTERS.map((f) => (
          <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => set({ filter: f.value })} className={chip(filter === f.value)}>
            {f.label}
            <span className={`tabular-nums text-xs ${filter === f.value ? 'text-black/60' : 'text-nf-muted'}`}>{counts[f.value]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NoMatches({ filter, query, onReset }: { filter: LibraryFilter; query: string; onReset: () => void }) {
  const label = LIBRARY_FILTERS.find((f) => f.value === filter)?.label.toLowerCase();
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <Gamepad2 aria-hidden="true" className="h-10 w-10 text-white/40" />
      <p className="text-lg text-nf-secondary">
        {query.trim() ? `No games${filter === 'all' ? '' : ` (${label})`} match “${query.trim()}”.` : `No ${label} games right now.`}
      </p>
      {filter !== 'all' && <button type="button" className="nf-btn-ghost" onClick={onReset}>Show all games</button>}
    </div>
  );
}

const item = {
  layout: 'position' as const,
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transition.fade },
  exit: { opacity: 0, transition: transition.exit },
  transition: transition.base,
};

/** Grid and List layouts: every library game, filtered and sorted. */
export function LibraryCollection({ layout, games, total, query, openers }: {
  layout: Exclude<LibraryLayout, 'rows'>;
  games: LibraryGame[];
  total: number;
  query: string;
  openers: GameOpeners;
}) {
  const filter = useLibraryView((s) => s.filter);
  const set = useLibraryView((s) => s.set);
  return (
    <section className="min-h-screen px-[4%] pb-16 pt-[148px]">
      <Toolbar total={total} shown={games.length} query={query} />
      {!games.length
        ? <NoMatches filter={filter} query={query} onReset={() => set({ filter: 'all' })} />
        : layout === 'grid'
          ? (
            <div className={POSTER_GRID}>
              <AnimatePresence initial={false}>
                {games.map((g) => (
                  <motion.div key={g.slug} {...item} className="min-w-0">
                    <GamePoster game={libraryCard(g)} openers={openers} caption />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )
          : <GameList games={games} openers={openers} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const COLUMNS = 'grid grid-cols-[56px_minmax(0,2.4fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_212px] xl:grid-cols-[56px_minmax(0,2.4fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_212px] items-center gap-x-4';

function shortDate(ms: number): string {
  if (!ms) return '—';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}

function SortHeader({ value, children, className = '' }: { value: LibrarySort; children: ReactNode; className?: string }) {
  const sort = useLibraryView((s) => s.sort);
  const set = useLibraryView((s) => s.set);
  const on = sort === value;
  return (
    <div role="columnheader" aria-sort={on ? (value === 'name' ? 'ascending' : 'descending') : 'none'} className={className}>
      <button type="button" onClick={() => set({ sort: value })} className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors ${on ? 'text-white' : 'hover:text-white'}`}>
        {children}
        <ArrowDown aria-hidden="true" className={`h-3 w-3 transition-opacity ${on ? 'opacity-100' : 'opacity-0'}`} />
      </button>
    </div>
  );
}

function GameList({ games, openers }: { games: LibraryGame[]; openers: GameOpeners }) {
  return (
    <div role="table" aria-label="Your games" className="overflow-hidden rounded-md border border-white/10 bg-white/[0.02]">
      <div role="row" className={`${COLUMNS} border-b border-white/10 bg-white/[0.03] px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-nf-muted`}>
        <div role="columnheader"><span className="sr-only">Cover</span></div>
        <SortHeader value="name">Title</SortHeader>
        <div role="columnheader">Status</div>
        <SortHeader value="size">Size</SortHeader>
        <SortHeader value="playtime">Play time</SortHeader>
        <SortHeader value="played">Last played</SortHeader>
        <SortHeader value="added" className="hidden xl:block">Added</SortHeader>
        <div role="columnheader"><span className="sr-only">Actions</span></div>
      </div>
      <div role="rowgroup">
        <AnimatePresence initial={false}>
          {games.map((g) => <ListRow key={g.slug} game={g} openers={openers} />)}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ListRow({ game, openers }: { game: LibraryGame; openers: GameOpeners }) {
  const { job, running, torrent } = useOwnedGame(game.slug);
  const installed = isInstalled(game) && !job;
  const progress = gameProgress(game, job, torrent);
  const failed = !job && (game.status === 'install_failed' || game.status === 'verify_failed');
  const status = running ? 'Playing now' : gameStatusLabel(game, job, torrent);
  const tone = running || installed ? 'text-nf-green' : failed ? 'text-amber-300' : game.status === 'downloaded' && !job ? 'text-white' : job ? 'text-white' : 'text-nf-download-text';
  const open = () => openers.onOpen(libraryCard(game));

  return (
    <motion.div
      {...item}
      role="row"
      onClick={open}
      className={`${COLUMNS} group cursor-pointer border-b border-white/[0.06] px-4 py-2.5 text-sm transition-colors last:border-0 hover:bg-white/[0.06]`}
    >
      <div role="cell" className="relative h-[72px] w-12 overflow-hidden rounded-sm bg-[#232323]">
        <GameCover url={game.cover} title={game.title} className={`h-full w-full ${job || game.status === 'downloading' ? 'opacity-50 grayscale' : ''}`} />
      </div>
      <div role="cell" className="min-w-0">
        <button type="button" onClick={(e) => { e.stopPropagation(); open(); }} aria-label={`View ${game.title}`}
          className="block max-w-full truncate text-left text-[15px] font-semibold text-white outline-none hover:underline focus-visible:underline">
          {game.title}
        </button>
        {game.subtitle && <div className="mt-0.5 truncate text-xs text-nf-muted">{game.subtitle}</div>}
      </div>
      <div role="cell" className="min-w-0">
        <div className={`flex items-center gap-1.5 truncate font-medium ${tone}`}>
          {job && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />}
          <span className="truncate">{status}</span>
        </div>
        {progress != null && <ProgressBar value={progress / 100} min={0.03} tone={job ? 'red' : 'download'} rounded animated className="mt-1.5 max-w-[180px]" />}
      </div>
      <div role="cell" className="tabular-nums text-nf-secondary">{game.sizeBytes ? formatBytes(game.sizeBytes) : '—'}</div>
      <div role="cell" className="tabular-nums text-nf-secondary">{game.playSeconds > 0 ? formatPlayTime(game.playSeconds) : '—'}</div>
      <div role="cell" className="text-nf-secondary">{game.lastPlayed ? shortDate(parseLibraryTime(game.lastPlayed)) : 'Never'}</div>
      <div role="cell" className="hidden text-nf-secondary xl:block">{shortDate(parseLibraryTime(game.createdAt))}</div>
      <div role="cell" className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
        <RowAction game={game} openers={openers} />
        <IconButton aria-label={`More info about ${game.title}`} title="More Info" variant="ghost" size="sm" onClick={open}><Info className="h-5 w-5" /></IconButton>
      </div>
    </motion.div>
  );
}

const PLAY = 'nf-btn-play h-8 min-w-[112px] gap-1.5 px-3 py-0 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY = 'nf-btn-info h-8 min-w-[112px] gap-1.5 px-3 py-0 text-sm disabled:cursor-not-allowed disabled:opacity-50';

/** The compact main action for a list row: Play, Install, Resume/Pause download, Cancel install. */
function RowAction({ game, openers }: { game: LibraryGame; openers: GameOpeners }) {
  const { job, running, torrent } = useOwnedGame(game.slug);
  const { busy, run } = useBusy();
  if (job) {
    const cancellable = ['starting', 'installing', 'finalizing'].includes(job.phase);
    return <button type="button" className={SECONDARY} disabled={busy || !cancellable} onClick={() => void run(() => cancelJob(game.id))}><X className="h-4 w-4" />Cancel</button>;
  }
  if (isInstalled(game)) {
    return (
      <button type="button" className={PLAY} disabled={running || busy || !game.exePath} onClick={() => void run(() => launchGame(game.id))}>
        <Play className="h-4 w-4 fill-black" strokeWidth={0} />{running ? 'Playing' : 'Play'}
      </button>
    );
  }
  if (game.status === 'downloading') {
    if (!torrent) return <button type="button" className={PLAY} disabled={busy} onClick={() => void run(() => retryDownload(game.id))}><RotateCcw className="h-4 w-4" />Retry</button>;
    return torrent.paused
      ? <button type="button" className={PLAY} disabled={busy} onClick={() => void run(() => resumeTorrent(torrent.infoHash))}><Play className="h-4 w-4 fill-black" strokeWidth={0} />Resume</button>
      : <button type="button" className={SECONDARY} disabled={busy} onClick={() => void run(() => pauseTorrent(torrent.infoHash))}><Pause className="h-4 w-4 fill-white" strokeWidth={0} />Pause</button>;
  }
  if (hasInstaller(game)) {
    return <button type="button" className={PLAY} onClick={() => openers.onInstall(game)}><Gamepad2 className="h-4 w-4" />{game.status === 'downloaded' ? 'Install' : 'Reinstall'}</button>;
  }
  if (game.status === 'install_failed') {
    return <button type="button" className={PLAY} disabled={busy || !game.detail} onClick={() => void run(() => retryDownload(game.id))}><RotateCcw className="h-4 w-4" />Download</button>;
  }
  return <button type="button" className={SECONDARY} disabled><Loader2 className="h-4 w-4 animate-spin" />Working</button>;
}
