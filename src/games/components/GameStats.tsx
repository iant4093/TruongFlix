import { useMemo, type ReactNode } from 'react';
import { BarChart3, CalendarDays, Clock, HardDrive, History, Rocket, Timer, Trophy } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { formatBytes } from '../../lib/format';
import { forgetGameStats, useGamesStore } from '../jobs';
import { statsFor, type GameStats } from '../stats';
import { useBusy } from './actions';
import { formatPlayTime } from './status';

/** A game's play stats from every install of it, live. Works for games no longer in the library. */
export function useGameStats({ slug, title }: { slug: string; title: string }): GameStats {
  const history = useGamesStore((s) => s.history);
  return useMemo(() => statsFor({ slug, title }, history), [slug, title, history]);
}

const longDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** "4 hrs 10 min" → "4h 10m", for tight card lines. */
export function shortPlayTime(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? '<1m' : '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ''}` : `${minutes}m`;
}

/** One line for library cards: total play and how much of it was this week. */
export function compactStats(stats: GameStats): string {
  if (stats.totalSeconds <= 0) return '';
  const week = stats.weekSeconds >= 60 ? ` · ${shortPlayTime(stats.weekSeconds)} this week` : '';
  return `Played ${shortPlayTime(stats.totalSeconds)}${week}`;
}

function Tile({ icon, label, children, hint }: { icon: ReactNode; label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-3" title={hint}>
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-nf-muted">{icon}{label}</div>
      <div className="mt-1 truncate text-[15px] font-semibold tabular-nums text-white">{children}</div>
    </div>
  );
}

/**
 * The detail view's stats. Shown for any game with play history, installed or not, since
 * uninstalling or removing a game keeps it; "Forget stats" is the only way it goes.
 */
export function GameStatsPanel({ game, sizeBytes, running }: { game: { slug: string; title: string }; sizeBytes: number | null; running: boolean }) {
  const stats = useGameStats(game);
  const { busy, run } = useBusy();
  if (stats.totalSeconds <= 0 && !sizeBytes) return null;
  const played = stats.totalSeconds > 0;
  const forget = async () => {
    const ok = await useLibraryStore.getState().confirm({
      title: 'Forget play stats?',
      message: `The play time, sessions and dates recorded for “${game.title}” will be deleted from TruongFlix, and it leaves your Wrapped. The game itself is not affected. This can’t be undone.`,
      confirmLabel: 'Forget stats',
      danger: true,
    });
    if (ok) await run(() => forgetGameStats(game));
  };
  const estimated = 'Includes play time from before each session was recorded.';
  return (
    <section aria-label="Your stats" className="px-12 pb-8">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h3 className="text-2xl font-bold">Your stats</h3>
        {played && (
          <button type="button" className="text-xs font-semibold text-nf-muted hover:text-white disabled:opacity-50" disabled={busy || running} onClick={() => void forget()}>
            Forget stats
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {played && <>
          <Tile icon={<Clock className="h-3.5 w-3.5" />} label="Total play" hint={stats.hasEstimated ? estimated : undefined}>{formatPlayTime(stats.totalSeconds)}</Tile>
          <Tile icon={<History className="h-3.5 w-3.5" />} label="Last played">{running ? 'Playing now' : stats.lastPlayed ? longDate(stats.lastPlayed) : '—'}</Tile>
          <Tile icon={<Rocket className="h-3.5 w-3.5" />} label="Times played" hint={stats.hasEstimated ? estimated : undefined}>
            {stats.launches}{stats.hasEstimated ? '+' : ''}
          </Tile>
          <Tile icon={<CalendarDays className="h-3.5 w-3.5" />} label="First played" hint={stats.firstPlayedApprox ? 'Recorded before sessions were; it may have been earlier.' : undefined}>
            {stats.firstPlayed ? `${stats.firstPlayedApprox ? 'By ' : ''}${longDate(stats.firstPlayed)}` : '—'}
          </Tile>
          <Tile icon={<Trophy className="h-3.5 w-3.5" />} label="Longest session">{stats.longestSeconds ? formatPlayTime(stats.longestSeconds) : '—'}</Tile>
          <Tile icon={<Timer className="h-3.5 w-3.5" />} label="This week">{stats.weekSeconds ? formatPlayTime(stats.weekSeconds) : 'None'}</Tile>
          <Tile icon={<BarChart3 className="h-3.5 w-3.5" />} label="This month">{stats.monthSeconds ? formatPlayTime(stats.monthSeconds) : 'None'}</Tile>
        </>}
        {sizeBytes ? <Tile icon={<HardDrive className="h-3.5 w-3.5" />} label="Size on disk">{formatBytes(sizeBytes)}</Tile> : null}
      </div>
      {played && !sizeBytes && <p className="mt-3 text-xs text-nf-muted">Kept from when it was installed. Reinstalling or downloading it again adds to the same stats.</p>}
    </section>
  );
}
