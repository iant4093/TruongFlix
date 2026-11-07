import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Gamepad2, Info, Loader2, Pause, Play, RefreshCw, Settings2 } from 'lucide-react';
import { errorMessage } from '../../lib/errors';
import { fetchGame, fetchNewest, fetchPopular, searchGames } from '../source';
import type { GameCard, GameDetail, GameRow as Row, LibraryGame } from '../types';
import { PrimaryAction } from './actions';
import GameBillboard, { GameBillboardSkeleton, Top10Badge } from './GameBillboard';
import { GameGrid, GameRow, GameRowSkeleton } from './GamePoster';

const ROTATE_MS = 12_000;
const navButton = 'flex h-9 w-9 items-center justify-center rounded-full border border-white/40 bg-black/35 hover:bg-white/15';

export interface GameOpeners {
  onOpen: (game: GameCard) => void;
  onDownload: (detail: GameDetail) => void;
  onInstall: (game: LibraryGame) => void;
}

/** Rotating billboard of the month's most popular games, like Browse's featured titles. */
function FeaturedGames({ origin, games, label, blocked, onOpen, onDownload, onInstall }: GameOpeners & {
  origin: string;
  games: GameCard[];
  label: string;
  blocked: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [rotation, setRotation] = useState<boolean | null>(null);
  const [details, setDetails] = useState<Record<string, GameDetail>>({});
  const reducedMotion = useReducedMotion();
  const rotating = rotation ?? !reducedMotion;
  const actions = useRef<HTMLDivElement>(null);
  const count = games.length;
  const position = index % count;
  const game = games[position];
  const detail = details[game.slug] ?? null;
  const move = useCallback((step: number) => setIndex((i) => (i + step + count) % count), [count]);

  useEffect(() => {
    if (details[game.slug]) return;
    let active = true;
    void fetchGame(origin, game.slug).then((d) => { if (active && d) setDetails((m) => ({ ...m, [game.slug]: d })); }).catch(() => {});
    return () => { active = false; };
  }, [origin, game.slug, details]);

  useEffect(() => {
    if (!rotating || count < 2 || blocked) return;
    const timer = window.setInterval(() => {
      if (!actions.current?.contains(document.activeElement)) move(1);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [rotating, count, blocked, move]);

  return (
    <div ref={actions}>
      <GameBillboard
        id={game.slug}
        title={game.title}
        detail={detail}
        cover={game.cover}
        eyebrow={<div className="text-shadow flex items-center gap-2.5 text-[clamp(0.95rem,1.4vw,1.4rem)] font-semibold"><Top10Badge />#{position + 1} in {label}</div>}
        overview={detail?.description}
        actions={<>
          <PrimaryAction slug={game.slug} detail={detail} size="xl" onDownload={() => detail && onDownload(detail)} onInstall={onInstall} />
          <button onClick={() => onOpen(detail ?? game)} className="nf-btn-info text-lg"><Info className="h-7 w-7" />More Info</button>
        </>}
        controls={count > 1 && (
          <div className="nf-billboard-controls right-[4%] gap-2" role="group" aria-label="Featured game controls">
            <button className={navButton} aria-label={rotating ? 'Pause game rotation' : 'Resume game rotation'} onClick={() => setRotation(!rotating)}>
              {rotating ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <button className={navButton} aria-label="Previous featured game" onClick={() => move(-1)}><ChevronLeft className="h-4 w-4" /></button>
            <span className="w-9 text-center text-xs tabular-nums text-white/75">{position + 1} / {count}</span>
            <button className={navButton} aria-label="Next featured game" onClick={() => move(1)}><ChevronRight className="h-4 w-4" /></button>
          </div>
        )}
      />
    </div>
  );
}

export function NoSource({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <section className="relative flex h-[85vh] min-h-[520px] items-center overflow-hidden px-[4%]">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(229,9,20,0.25),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(229,9,20,0.12),transparent_50%)]" />
      <div className="relative max-w-xl space-y-5">
        <Gamepad2 aria-hidden="true" className="h-12 w-12 text-white/70" />
        <h2 className="text-5xl font-black leading-tight">Add a game source</h2>
        <p className="text-lg text-nf-secondary">Add the website you get games from. TruongFlix lists its games here and downloads them with the built-in torrent client.</p>
        <button className="nf-btn-play text-lg" onClick={onOpenSettings}><Settings2 className="h-6 w-6" />Add game source</button>
      </div>
    </section>
  );
}

function ErrorBar({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mx-[4%] mb-6 flex items-center gap-3 rounded border border-white/15 bg-white/5 p-4 text-sm text-white/70">
      <span>{error}</span>
      <button className="nf-btn-ghost ml-auto" onClick={onRetry}><RefreshCw className="h-4 w-4" />Retry</button>
    </div>
  );
}

export default function GameBrowse({ origin, query, blocked, onOpenSettings, onSearching, ...openers }: GameOpeners & {
  origin: string;
  query: string;
  blocked: boolean;
  onOpenSettings: () => void;
  onSearching: (searching: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [results, setResults] = useState<{ query: string; games: GameDetail[]; page: number; pages: number } | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => { onSearching(searching); }, [searching, onSearching]);

  useEffect(() => {
    if (!origin) return;
    let active = true;
    setRows(null);
    setError('');
    void Promise.allSettled([fetchPopular(origin), fetchNewest(origin, 1)]).then(([popular, newest]) => {
      if (!active) return;
      const out: Row[] = [];
      if (popular.status === 'fulfilled') out.push(...popular.value.filter((r) => r.games.length));
      if (newest.status === 'fulfilled' && newest.value.games.length) out.splice(Math.min(1, out.length), 0, { title: 'Newly added', games: newest.value.games });
      if (!out.length) {
        const failure = [popular, newest].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        setError(failure ? errorMessage(failure.reason) : 'The game source returned no games.');
      }
      setRows(out);
    });
    return () => { active = false; };
  }, [origin, reload]);

  useEffect(() => {
    const q = query.trim();
    if (!q || !origin) { setResults(null); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchGames(origin, q, 1)
        .then((r) => { if (active) setResults({ query: q, games: r.games, page: 1, pages: r.totalPages }); })
        .catch((e) => { if (active) { setResults({ query: q, games: [], page: 1, pages: 1 }); setError(errorMessage(e)); } })
        .finally(() => { if (active) setSearching(false); });
    }, 400);
    return () => { active = false; window.clearTimeout(timer); setSearching(false); };
  }, [query, origin]);

  const loadMore = async () => {
    if (!results || searching) return;
    setSearching(true);
    try {
      const next = await searchGames(origin, results.query, results.page + 1);
      setResults((r) => (r ? { ...r, games: [...r.games, ...next.games.filter((g) => !r.games.some((x) => x.slug === g.slug))], page: r.page + 1, pages: next.totalPages } : r));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  };

  if (!origin) return <NoSource onOpenSettings={onOpenSettings} />;
  const retry = () => { setError(''); setReload((n) => n + 1); };

  if (query.trim()) {
    return (
      <section className="min-h-screen px-[4%] pb-16 pt-[148px]">
        {error && <ErrorBar error={error} onRetry={retry} />}
        <h2 className="mb-6 text-[clamp(1.4rem,2.2vw,2.2rem)] font-semibold">
          {results ? <>Results for “{results.query}”</> : <>Searching for “{query.trim()}”…</>}
        </h2>
        {results && results.games.length === 0 && !searching
          ? <p className="pt-10 text-center text-lg text-nf-secondary">Your search for “{results.query}” did not match any games.</p>
          : results && <GameGrid games={results.games} onOpen={openers.onOpen} />}
        {(searching && !results) && <div role="status" className="flex justify-center gap-3 py-16 text-white/60"><Loader2 className="h-5 w-5 animate-spin" />Searching games…</div>}
        {results && results.page < results.pages && (
          <div className="mt-10 flex justify-center">
            <button className="nf-btn-ghost" disabled={searching} onClick={() => void loadMore()}>{searching && <Loader2 className="h-4 w-4 animate-spin" />}Load more</button>
          </div>
        )}
      </section>
    );
  }

  const featuredRow = rows?.find((r) => r.title !== 'Newly added') ?? rows?.[0];
  const featured = featuredRow?.games.slice(0, 6) ?? [];
  const period = featuredRow?.title.toLowerCase().match(/week|month|year/)?.[0];
  const label = period ? `Games This ${period[0].toUpperCase()}${period.slice(1)}` : 'New Games';

  return (
    <div>
      {rows === null ? <GameBillboardSkeleton />
        : featured.length > 0 ? <FeaturedGames origin={origin} games={featured} label={label} blocked={blocked} {...openers} />
          : <div className="pt-[148px]" />}
      <div className={`relative z-10 flow-root pb-16 ${rows === null || featured.length ? '-mt-32' : ''}`}>
        {error && <ErrorBar error={error} onRetry={retry} />}
        {rows === null
          ? <><GameRowSkeleton /><GameRowSkeleton /></>
          : rows.map((row) => <GameRow key={row.title} title={rowTitle(row.title)} games={row.games} onOpen={openers.onOpen} />)}
      </div>
    </div>
  );
}

/** Source widget titles read like section headings ("Most Popular Repacks of the Month"); match the app's row names. */
function rowTitle(title: string) {
  const t = title.toLowerCase();
  if (t.includes('popular') && t.includes('month')) return 'Popular This Month';
  if (t.includes('popular') && t.includes('year')) return 'Popular This Year';
  if (t.includes('popular') && t.includes('week')) return 'Popular This Week';
  if (t === 'newly added') return 'Newly Added';
  return title;
}
