import { Fragment } from 'react';
import type { SportsEvent } from '../../types/live';
import { LiveArtwork } from './LiveArtwork';

export default function EventScoreboard({ event, compact = false }: { event: SportsEvent; compact?: boolean }) {
  const teams = event.teams.slice(0, 2);
  const showScores = event.status !== 'upcoming' && !/cancel|postpon/i.test(event.detail);
  return (
    // `isolate`: the glows sit behind the team names but above this background.
    <div className={`relative isolate flex items-center justify-center overflow-hidden bg-gradient-to-br from-white/5 to-black/50 ${compact ? 'h-20' : 'h-44'}`}>
      <div className="relative grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-6">
        {teams.map((team, index) => (
          <Fragment key={team.id}>
            <div className={`relative flex min-w-0 items-center text-center ${compact ? 'justify-center gap-3' : 'flex-col gap-2'}`}>
              {/* A soft glow in the team's colour, centred behind it. A gradient, not a blurred
                  circle: the blur showed a hard edge partway across the card, and dozens of them
                  made a busy day of games slow to scroll. */}
              <span
                aria-hidden
                className={`pointer-events-none absolute left-1/2 top-1/2 -z-10 -translate-x-1/2 -translate-y-1/2 ${compact ? 'h-32 w-32' : 'h-60 w-60'}`}
                style={{ background: glow(team.color) }}
              />
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

/** A radial glow in a `#rrggbb` team colour, fading out to its edge; none for other values. */
function glow(color?: string) {
  const rgb = color && /^#?([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!rgb) return undefined;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(rgb.slice(i, i + 2), 16));
  return `radial-gradient(closest-side, rgba(${r},${g},${b},0.28), rgba(${r},${g},${b},0.1) 55%, transparent)`;
}
