import { ArrowRight, Star } from 'lucide-react';
import { setLivePreferences, useLiveStore, type ChannelMatch } from '../../services/live';
import type { SportsEvent } from '../../types/live';
import { LiveArtwork } from './LiveArtwork';
import { leagueLabel, timeLabel } from './ui';

export default function EventCard({
  event,
  matches,
  onOpen,
}: {
  event: SportsEvent;
  matches: ChannelMatch[];
  onOpen: () => void;
}) {
  const teams = useLiveStore((s) => s.preferences.teams);
  const favourite = event.teams.some((t) => teams.includes(t.id));
  return (
    <article className="relative overflow-hidden rounded-lg border border-white/10 bg-[#202020] transition hover:-translate-y-1 hover:border-white/25">
      <button onClick={onOpen} className="w-full text-left">
        <div className="relative flex h-36 items-center justify-center gap-7 overflow-hidden bg-gradient-to-br from-white/5 to-black/50">
          <div
            className="absolute -left-12 -top-12 h-44 w-44 rounded-full opacity-20 blur-3xl"
            style={{ background: event.teams[0]?.color }}
          />
          <div
            className="absolute -bottom-12 -right-12 h-44 w-44 rounded-full opacity-20 blur-3xl"
            style={{ background: event.teams[1]?.color }}
          />
          {event.teams.slice(0, 2).map((team, index) => (
            <div key={team.id} className="z-10 flex items-center gap-6">
              <div className="text-center">
                <LiveArtwork url={team.logo} className="h-16 w-16" />
                <div className="mt-2 text-xs font-bold tracking-wider">{team.abbreviation || team.name}</div>
              </div>
              {index === 0 && <span className="text-xs font-bold text-white/30">VS</span>}
            </div>
          ))}
        </div>
        <div className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider">
            <span className="text-nf-muted">{leagueLabel(event.league)}</span>
            <span className={event.status === 'live' ? 'text-red-400' : 'text-nf-secondary'}>
              {event.status === 'live' ? '● Live' : event.status === 'finished' ? 'Final' : timeLabel(event.date)}
            </span>
          </div>
          <h3 className="min-h-10 text-sm font-bold leading-5">{event.name}</h3>
          <p className="mt-2 truncate text-xs text-nf-secondary">
            {event.broadcasts.join(' · ') || 'Broadcaster not listed'}
          </p>
          <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-xs">
            <span className={matches.length ? 'text-white' : 'text-nf-muted'}>
              {matches.length
                ? `${matches.length} matching ${matches.length === 1 ? 'feed' : 'feeds'}`
                : 'No available matching feed'}
            </span>
            <ArrowRight className="h-4 w-4" />
          </div>
        </div>
      </button>
      <button
        className="absolute right-2 top-2 rounded-full bg-black/40 p-2 text-white/70 hover:text-yellow-400"
        title="Favourite these teams"
        aria-label={`Favourite teams in ${event.name}`}
        aria-pressed={favourite}
        onClick={() =>
          void setLivePreferences({
            teams: favourite
              ? teams.filter((id) => !event.teams.some((t) => t.id === id))
              : [...new Set([...teams, ...event.teams.map((t) => t.id)])],
          })
        }
      >
        <Star className={`h-4 w-4 ${favourite ? 'fill-yellow-400 text-yellow-400' : ''}`} />
      </button>
    </article>
  );
}
