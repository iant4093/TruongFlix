import { useMemo } from 'react';
import { Gamepad2, Info, Search } from 'lucide-react';
import { useGamesStore } from '../jobs';
import type { GameCard, LibraryGame } from '../types';
import { PrimaryAction, useOwnedGame } from './actions';
import type { GameOpeners } from './GameBrowse';
import GameBillboard from './GameBillboard';
import { GameGrid, GameRow } from './GamePoster';
import { formatPlayTime, gameStatusLabel, isInstalled } from './status';

export const libraryCard = (game: LibraryGame): GameCard =>
  game.detail ?? { slug: game.slug, title: game.title, subtitle: game.subtitle, cover: game.cover, postId: null, date: null };

const time = (value: string | null) => (value ? Date.parse(value) || 0 : 0);
const newest = (key: 'lastPlayed' | 'installedAt' | 'createdAt') => (a: LibraryGame, b: LibraryGame) => time(b[key]) - time(a[key]);

function relativeDay(value: string) {
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Billboard for the game you're most likely to want next: last played, newly installed, or still on its way. */
function LibraryBillboard({ game, onOpen, onDownload, onInstall }: GameOpeners & { game: LibraryGame }) {
  const { job, running, torrent } = useOwnedGame(game.slug);
  const installed = isInstalled(game) && !job;
  const eyebrow = running ? 'Playing now' : installed ? (game.lastPlayed ? 'Continue playing' : 'Recently installed') : 'In progress';
  const extra = installed
    ? <span className="text-nf-green">{game.lastPlayed ? `Played ${relativeDay(game.lastPlayed)} · ${formatPlayTime(game.playSeconds)} total` : 'Ready to play'}</span>
    : <span className={job ? 'text-white' : 'text-sky-300'}>{gameStatusLabel(game, job, torrent)}</span>;
  return (
    <GameBillboard
      id={`library-${game.id}`}
      title={game.title}
      detail={game.detail}
      cover={game.cover}
      eyebrow={<p className="text-shadow text-[clamp(0.8rem,1vw,1rem)] font-semibold uppercase tracking-[0.25em] text-[#e5e5e5]">{eyebrow}</p>}
      extra={extra}
      overview={game.detail?.description}
      actions={<>
        <PrimaryAction slug={game.slug} detail={game.detail} size="xl" onDownload={() => game.detail && onDownload(game.detail)} onInstall={onInstall} />
        <button onClick={() => onOpen(libraryCard(game))} className="nf-btn-info text-lg"><Info className="h-7 w-7" />More Info</button>
      </>}
    />
  );
}

function EmptyLibrary({ onBrowse }: { onBrowse: () => void }) {
  return (
    <section className="relative flex h-[85vh] min-h-[520px] items-center overflow-hidden px-[4%]">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(229,9,20,0.25),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(229,9,20,0.12),transparent_50%)]" />
      <div className="relative max-w-xl space-y-5">
        <Gamepad2 aria-hidden="true" className="h-12 w-12 text-white/70" />
        <h2 className="text-5xl font-black leading-tight">Your game library is empty</h2>
        <p className="text-lg text-nf-secondary">Games you download and install appear here, ready to play.</p>
        <button className="nf-btn-play text-lg" onClick={onBrowse}><Search className="h-6 w-6" />Browse games</button>
      </div>
    </section>
  );
}

export default function GameLibrary({ query, onBrowse, ...openers }: GameOpeners & { query: string; onBrowse: () => void }) {
  const games = useGamesStore((s) => s.games);
  const jobs = useGamesStore((s) => s.jobs);

  const { featured, rows } = useMemo(() => {
    const installed = games.filter((g) => isInstalled(g) && !jobs[g.id]);
    const played = installed.filter((g) => g.lastPlayed).sort(newest('lastPlayed'));
    const active = games.filter((g) => !isInstalled(g) || !!jobs[g.id]);
    const featured = played[0] ?? [...installed].sort(newest('installedAt'))[0] ?? active[0] ?? null;
    return {
      featured,
      rows: [
        { title: 'Continue Playing', games: played },
        { title: 'Downloads & Installs', games: active },
        { title: 'Installed', games: [...installed].sort((a, b) => a.title.localeCompare(b.title)) },
        { title: 'Recently Added', games: [...games].sort(newest('createdAt')).slice(0, 24) },
      ].filter((r) => r.games.length),
    };
  }, [games, jobs]);

  const q = query.trim().toLowerCase();
  if (q) {
    const matches = games.filter((g) => g.title.toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title));
    return (
      <section className="min-h-screen px-[4%] pb-16 pt-[148px]">
        <h2 className="mb-6 text-[clamp(1.4rem,2.2vw,2.2rem)] font-semibold">Results for “{query.trim()}” in your games</h2>
        {matches.length
          ? <GameGrid games={matches.map(libraryCard)} onOpen={openers.onOpen} />
          : <p className="pt-10 text-center text-lg text-nf-secondary">No games in your library match “{query.trim()}”.</p>}
      </section>
    );
  }

  if (!games.length) return <EmptyLibrary onBrowse={onBrowse} />;

  return (
    <div>
      {featured && <LibraryBillboard key={featured.id} game={featured} {...openers} />}
      <div className="relative z-10 flow-root -mt-32 pb-16">
        {rows.map((row) => <GameRow key={row.title} title={row.title} games={row.games.map(libraryCard)} onOpen={openers.onOpen} />)}
      </div>
    </div>
  );
}
