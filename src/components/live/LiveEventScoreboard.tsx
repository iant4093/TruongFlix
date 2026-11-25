import { Fragment } from 'react';
import type { SportsEvent } from '../../types/live';
import { LiveArtwork } from './LiveArtwork';

export default function EventScoreboard({ event, compact = false }: { event: SportsEvent; compact?: boolean }) {
  const teams = event.teams.slice(0, 2);
  const showScores = event.status !== 'upcoming' && !/cancel|postpon/i.test(event.detail);
  return (
    <div className={`relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-white/5 to-black/50 ${compact ? 'h-20' : 'h-44'}`}>
      {/* Soft team-colour glows in the corners. Painted as gradients, not blurred circles: a blur
          filter showed a hard edge partway across the card (WebKit clips it), and dozens of them
          made a busy day of games slow to scroll. */}
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: glows(teams[0]?.color, teams[1]?.color) }} />
      <div className="relative grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-6">
        {teams.map((team, index) => (
          <Fragment key={team.id}>
            <div className={`flex min-w-0 items-center text-center ${compact ? 'justify-center gap-3' : 'flex-col gap-2'}`}>
              <LiveArtwork url={team.logo} className={compact ? 'h-8 w-8' : 'h-12 w-12'} />
              <span
                className={`${compact ? 'max-w-24' : 'w-full'} truncate text-xs font-bold tracking-wider`}
                title={team.rank ? `#${team.rank} ${team.name}` : team.name}
              >
                {team.rank ? <span className="mr-1 text-nf-secondary" aria-label={`Ranked ${team.rank}`}>{team.rank}</span> : null}
                {team.abbreviation || team.name}
              </span>
              {showScores && (
                <span
                  aria-label={`${team.name} score: ${team.score || 'unavailable'}`}
                  className={`${compact ? 'text-2xl' : 'text-3xl'} font-bold leading-none tabular-nums`}
                >
                  {team.score || '—'}
                </span>
              )}
            </div>
            {index === 0 && teams.length > 1 && <span className="text-xs font-bold text-white/30">VS</span>}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** The two corner glows as one background, `#rrggbb` (or `rrggbb`) team colours at 20%. */
function glows(first?: string, second?: string) {
  const layers = [
    [first, '2.5rem 2.5rem'],
    [second, 'calc(100% - 2.5rem) calc(100% - 2.5rem)'],
  ].flatMap(([color, at]) => {
    const rgb = color && /^#?([0-9a-f]{6})$/i.exec(color.trim())?.[1];
    if (!rgb) return [];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(rgb.slice(i, i + 2), 16));
    return [`radial-gradient(circle 9rem at ${at}, rgba(${r},${g},${b},0.2), rgba(${r},${g},${b},0.08) 55%, transparent)`];
  });
  return layers.join(', ') || undefined;
}
