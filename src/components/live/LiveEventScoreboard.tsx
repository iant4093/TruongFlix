import { Fragment } from 'react';
import type { SportsEvent } from '../../types/live';
import { LiveArtwork } from './LiveArtwork';

export default function EventScoreboard({ event, compact = false }: { event: SportsEvent; compact?: boolean }) {
  const teams = event.teams.slice(0, 2);
  const showScores = event.status !== 'upcoming' && !/cancel|postpon/i.test(event.detail);
  return (
    <div className={`relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-white/5 to-black/50 ${compact ? 'h-20' : 'h-44'}`}>
      <div
        className="absolute -left-12 -top-12 h-44 w-44 rounded-full opacity-20 blur-3xl"
        style={{ background: teams[0]?.color }}
      />
      <div
        className="absolute -bottom-12 -right-12 h-44 w-44 rounded-full opacity-20 blur-3xl"
        style={{ background: teams[1]?.color }}
      />
      <div className="relative grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-6">
        {teams.map((team, index) => (
          <Fragment key={team.id}>
            <div className={`flex min-w-0 items-center text-center ${compact ? 'justify-center gap-3' : 'flex-col gap-2'}`}>
              <LiveArtwork url={team.logo} className={compact ? 'h-8 w-8' : 'h-12 w-12'} />
              <span className={`${compact ? 'max-w-20' : 'w-full'} truncate text-xs font-bold tracking-wider`} title={team.name}>
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
