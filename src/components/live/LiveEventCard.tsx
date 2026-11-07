import { ArrowRight, Star } from 'lucide-react';
import { setLivePreferences, useLiveStore, type ChannelMatch } from '../../services/live';
import type { SportsEvent } from '../../types/live';
import EventScoreboard from './LiveEventScoreboard';
import { eventStatusLabel, leagueLabel } from './ui';

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
    <article className="relative overflow-hidden rounded-lg border border-white/10 bg-nf-hover transition hover:-translate-y-1 hover:border-white/25">
      <button onClick={onOpen} className="w-full text-left">
        <EventScoreboard event={event} />
        <div className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider">
            <span className="text-nf-muted">{leagueLabel(event.league)}</span>
            <span className={`text-right ${event.status === 'live' ? 'text-red-400' : 'text-nf-secondary'}`}>
              {eventStatusLabel(event)}
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
        title="Favorite these teams"
        aria-label={`Favorite teams in ${event.name}`}
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
