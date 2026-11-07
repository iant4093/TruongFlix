import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Gamepad2, Info, Loader2, RefreshCw, Search } from 'lucide-react';
import { fetchGame, fetchNewest, fetchPopular, searchGames } from '../source';
import { useGamesStore } from '../jobs';
import type { GameCard, GameDetail, GameRow } from '../types';
import GameCover, { useCachedImage } from './GameCover';
import GameDetailDialog from './GameDetailDialog';
import DownloadDialog from './DownloadDialog';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Poster({ game, onSelect, width = 'w-[150px] lg:w-[170px]' }: { game: GameCard; onSelect: (g: GameCard) => void; width?: string }) {
  const owned = useGamesStore((s) => s.games.some((g) => g.slug === game.slug));
  return <button type="button" onClick={() => onSelect(game)} aria-label={`View ${game.title}`} className={`group shrink-0 text-left ${width}`}>
    <div className="relative overflow-hidden rounded-md ring-white/70 transition duration-200 group-hover:-translate-y-1 group-hover:ring-2 group-focus-visible:ring-2">
      <GameCover url={game.cover} title={game.title} className="aspect-[3/4] w-full" />
      {owned && <span className="absolute bottom-2 left-2 rounded bg-black/85 px-2 py-1 text-[10px] font-semibold">In your library</span>}
    </div>
    <h3 className="mt-2.5 line-clamp-2 text-sm font-semibold leading-snug">{game.title}</h3>
    {game.subtitle && <p className="mt-0.5 truncate text-xs text-white/50">{game.subtitle}</p>}
  </button>;
}

function Row({ row, onSelect }: { row: GameRow; onSelect: (g: GameCard) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: 'smooth' });
  return <section className="group/row relative mb-9">
    <h2 className="nf-row-title mb-3 px-[4%]">{row.title}</h2>
    <button aria-label={`Scroll ${row.title} left`} onClick={() => scroll(-1)} className="absolute bottom-16 left-0 top-10 z-10 hidden w-[4%] items-center justify-center bg-black/50 opacity-0 transition group-hover/row:opacity-100 md:flex"><ChevronLeft className="h-8 w-8" /></button>
    <div ref={scroller} className="no-scrollbar flex gap-3 overflow-x-auto scroll-smooth px-[4%] pb-2 pt-1">
      {row.games.map((g) => <Poster key={g.slug} game={g} onSelect={onSelect} />)}
    </div>
    <button aria-label={`Scroll ${row.title} right`} onClick={() => scroll(1)} className="absolute bottom-16 right-0 top-10 z-10 hidden w-[4%] items-center justify-center bg-black/50 opacity-0 transition group-hover/row:opacity-100 md:flex"><ChevronRight className="h-8 w-8" /></button>
  </section>;
}

function Hero({ origin, games, onSelect, onDownload }: {
  origin: string;
  games: GameCard[];
  onSelect: (g: GameCard | GameDetail) => void;
  onDownload: (g: GameDetail) => void;
}) {
  const [index, setIndex] = useState(0);
  const [details, setDetails] = useState<Record<string, GameDetail>>({});
  const game = games[index % games.length];
  const detail = game ? details[game.slug] : undefined;
  const backdrop = useCachedImage(detail?.screenshots[0]?.full ?? null, detail?.screenshots[0]?.thumb ?? game?.cover);

  useEffect(() => {
    if (!game || details[game.slug]) return;
    let active = true;
    void fetchGame(origin, game.slug).then((d) => { if (active && d) setDetails((m) => ({ ...m, [game.slug]: d })); }).catch(() => {});
    return () => { active = false; };
  }, [origin, game, details]);
  useEffect(() => {
    if (games.length < 2) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % games.length), 12_000);
    return () => window.clearInterval(timer);
  }, [games.length]);

  if (!game) return null;
  return <div className="relative h-[62vh] min-h-[420px] w-full overflow-hidden">
    {backdrop && <img key={backdrop} src={backdrop} alt="" className="absolute inset-0 h-full w-full scale-105 object-cover opacity-60 blur-[2px] transition-opacity duration-700" />}
    <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/70 to-transparent" />
    <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#141414] to-transparent" />
    <div className="relative flex h-full items-end gap-8 px-[4%] pb-40">
      <GameCover url={game.cover} title={game.title} className="hidden aspect-[3/4] w-44 shrink-0 rounded-md shadow-card md:block lg:w-52" />
      <div className="max-w-2xl">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Popular now</p>
        <h1 className="text-4xl font-bold leading-tight text-shadow lg:text-5xl">{game.title}</h1>
        {game.subtitle && <p className="mt-2 text-sm text-white/70">{game.subtitle}</p>}
        {detail && <p className="mt-3 text-sm text-white/70">{[detail.genres.slice(0, 3).join(', '), detail.repackSize && `${detail.repackSize} download`].filter(Boolean).join(' · ')}</p>}
        {detail?.description && <p className="mt-4 line-clamp-3 text-sm leading-relaxed text-white/80">{detail.description}</p>}
        <div className="mt-6 flex gap-3">
          <button className="nf-btn-play" disabled={!detail?.magnet} onClick={() => detail && onDownload(detail)}><Download className="h-5 w-5" />Download</button>
          <button className="nf-btn-info" onClick={() => onSelect(detail ?? game)}><Info className="h-5 w-5" />More info</button>
        </div>
      </div>
    </div>
    {games.length > 1 && <div className="absolute bottom-28 right-[4%] flex gap-1.5">
      {games.map((g, i) => <button key={g.slug} aria-label={`Show ${g.title}`} onClick={() => setIndex(i)}
        className={`h-1.5 rounded-full transition-all ${i === index % games.length ? 'w-6 bg-white' : 'w-2 bg-white/40'}`} />)}
    </div>}
  </div>;
}

export default function GameBrowse({ origin, onOpenSettings, onOpenLibrary }: { origin: string; onOpenSettings: () => void; onOpenLibrary: () => void }) {
  const [rows, setRows] = useState<GameRow[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; games: GameDetail[]; page: number; pages: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<GameCard | GameDetail | null>(null);
  const [downloading, setDownloading] = useState<GameDetail | null>(null);

  useEffect(() => {
    if (!origin) return;
    let active = true;
    setRows(null);
    setError('');
    void Promise.allSettled([fetchPopular(origin), fetchNewest(origin, 1)]).then(([popular, newest]) => {
      if (!active) return;
      const out: GameRow[] = [];
      if (popular.status === 'fulfilled') out.push(...popular.value.filter((r) => r.games.length));
      if (newest.status === 'fulfilled' && newest.value.games.length) out.splice(Math.min(1, out.length), 0, { title: 'Newly added', games: newest.value.games });
      if (!out.length) {
        const failure = [popular, newest].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        setError(failure ? message(failure.reason) : 'The game source returned no games.');
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
        .catch((e) => { if (active) { setResults({ query: q, games: [], page: 1, pages: 1 }); setError(message(e)); } })
        .finally(() => { if (active) setSearching(false); });
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, origin]);

  const loadMore = async () => {
    if (!results || searching) return;
    setSearching(true);
    try {
      const next = await searchGames(origin, results.query, results.page + 1);
      setResults((r) => (r ? { ...r, games: [...r.games, ...next.games.filter((g) => !r.games.some((x) => x.slug === g.slug))], page: r.page + 1, pages: next.totalPages } : r));
    } catch (e) {
      setError(message(e));
    } finally {
      setSearching(false);
    }
  };

  if (!origin) return <div className="px-[4%] pt-8 text-center">
    <Gamepad2 className="mx-auto mb-5 h-12 w-12 text-white/40" />
    <h2 className="text-2xl font-bold">Add a game source</h2>
    <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/60">Add the website you get games from. TruongFlix lists its games here and downloads them with the built-in torrent client.</p>
    <button className="nf-btn-red mx-auto mt-6" onClick={onOpenSettings}>Add game source</button>
  </div>;

  const featured = rows?.[0]?.games.slice(0, 6) ?? [];
  return <div className="pb-16">
    {!results && featured.length > 0 && <Hero origin={origin} games={featured} onSelect={setSelected} onDownload={setDownloading} />}
    <div className={`relative z-10 ${!results && featured.length ? '-mt-28' : ''}`}>
      <div className="mb-7 flex items-center gap-4 px-[4%]">
        <label className="flex w-full max-w-md items-center gap-2 rounded border border-white/25 bg-black/50 px-3 py-2.5">
          <Search className="h-4 w-4 text-white/60" />
          <input aria-label="Search games" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games" className="w-full bg-transparent text-sm outline-none placeholder:text-white/40" />
          {searching && <Loader2 className="h-4 w-4 animate-spin text-white/60" />}
        </label>
      </div>
      {error && <div role="alert" className="mx-[4%] mb-6 flex items-center gap-3 rounded border border-white/15 bg-white/5 p-4 text-sm text-white/70">
        <span>{error}</span>
        <button className="nf-btn-ghost ml-auto" onClick={() => { setError(''); setReload((n) => n + 1); }}><RefreshCw className="h-4 w-4" />Retry</button>
      </div>}
      {results ? <section className="px-[4%]">
        <h2 className="nf-row-title mb-4">Results for “{results.query}”</h2>
        {results.games.length === 0 && !searching
          ? <p className="py-16 text-center text-white/50">No games found.</p>
          : <div className="grid grid-cols-3 gap-x-4 gap-y-7 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
            {results.games.map((g) => <Poster key={g.slug} game={g} onSelect={setSelected} width="w-full" />)}
          </div>}
        {results.page < results.pages && <div className="mt-8 flex justify-center">
          <button className="nf-btn-ghost" disabled={searching} onClick={() => void loadMore()}>{searching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Load more</button>
        </div>}
      </section> : rows === null
        ? <div role="status" className="flex justify-center gap-3 py-24 text-white/60"><Loader2 className="h-5 w-5 animate-spin" />Loading games…</div>
        : rows.map((row) => <Row key={row.title} row={row} onSelect={setSelected} />)}
    </div>
    {selected && <GameDetailDialog origin={origin} game={selected} onClose={() => setSelected(null)} onOpenLibrary={onOpenLibrary} />}
    {downloading && <DownloadDialog detail={downloading} onClose={() => setDownloading(null)} onStarted={onOpenLibrary} />}
  </div>;
}
