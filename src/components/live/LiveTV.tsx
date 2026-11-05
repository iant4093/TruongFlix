import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  Star,
} from 'lucide-react';
import Dropdown from '../common/Dropdown';
import { useLibraryStore } from '../../store/useLibraryStore';
import { guardAdult } from '../../services/profilelock';
import { playLive } from '../../services/player';
import {
  cancelChecks,
  channelKey,
  checkChannels,
  eventMatches,
  initLive,
  LEAGUES,
  localDate,
  setLivePreferences,
  sportsSchedule,
  useLiveStore,
} from '../../services/live';
import type { SportsEvent } from '../../types/live';
import { LiveArtwork } from './LiveArtwork';
import EventCard from './LiveEventCard';
import Sources from './LiveSources';
import EventFeeds from './LiveEventFeeds';
import { button, leagueLabel } from './ui';

const dateLabel = (date: Date) =>
  date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export default function LiveTV() {
  const profile = useLibraryStore((s) => s.activeProfile);
  const toast = useLibraryStore((s) => s.toast);
  const playerOpen = useLibraryStore((s) => !!s.playerSession);
  const state = useLiveStore();
  const [tab, setTab] = useState<'sports' | 'channels'>('sports');
  const [league, setLeague] = useState('football/nfl');
  const [day, setDay] = useState(() => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return d;
  });
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [count, setCount] = useState(60);
  const [events, setEvents] = useState<SportsEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [stale, setStale] = useState(false);
  const [updated, setUpdated] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const forcedRefresh = useRef(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);
  const [clock, setClock] = useState(0);

  useEffect(() => {
    if (profile) void initLive(profile.id).catch(() => toast('Could not load Live TV sources', 'error'));
  }, [profile?.id]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((c) => c + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const selected = state.preferences.playlist;
  const playlists = useMemo(
    () =>
      selected === 'all'
        ? state.playlists
        : state.playlists.filter((p) => p.id === (selected || state.playlists[0]?.id)),
    [selected, state.playlists],
  );
  const playlistIds = playlists.map((p) => p.id).join(',');
  const date = localDate(day);

  useEffect(() => {
    setEvents([]);
    setUpdated(0);
    setStale(false);
    setScheduleError('');
    setSelectedEvent(null);
  }, [league, date]);

  useEffect(() => {
    let alive = true;
    let busy = false;
    let timer = 0;
    if (profile?.maturity !== 'all' || tab !== 'sports' || playerOpen) return;
    const leagues = league === 'all' ? LEAGUES.map(([id]) => id) : [league];
    let force = refresh !== forcedRefresh.current;
    forcedRefresh.current = refresh;
    const poll = async () => {
      if (!alive || busy || document.hidden) return;
      busy = true;
      setLoading(true);
      const results = await Promise.allSettled(leagues.map((id) => sportsSchedule(id, date, force)));
      force = false;
      busy = false;
      if (!alive) return;
      const good = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const next = good.flatMap((r) => r.events).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      if (good.length) {
        setEvents(next);
        setUpdated(Math.min(...good.map((r) => r.fetchedAt)));
      }
      setStale(!good.length || good.some((r) => r.stale));
      setScheduleError(
        results.some((r) => r.status === 'rejected')
          ? good.length
            ? 'Some leagues could not be refreshed.'
            : 'Sports schedules are unavailable. You can still browse and play your channels.'
          : '',
      );
      setLoading(false);
      timer = window.setTimeout(() => void poll(), next.some((e) => e.status === 'live') ? 30_000 : 60_000);
    };
    const visibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', visibility);
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [profile?.maturity, league, date, refresh, tab, playerOpen]);

  useEffect(() => {
    if (!state.ready || profile?.maturity !== 'all') return;
    const current = useLiveStore.getState();
    if (current.checking || current.profileId !== profile?.id) return;
    const sources = current.playlists.filter((p) => playlistIds.split(',').includes(p.id));
    const targets =
      tab === 'sports'
        ? events
            .filter((e) => e.status !== 'finished')
            .flatMap((e) => eventMatches(e, sources, true, current.preferences.matches))
        : sources.flatMap((playlist) =>
            playlist.channels
              .filter(
                (channel) =>
                  `${channel.name} ${channel.tvgId} ${channel.group}`
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase()) &&
                  (group === 'all' || channel.group.split(';').includes(group)) &&
                  (!favouritesOnly || current.preferences.favourites.includes(channelKey(playlist.id, channel.id))),
              )
              .slice(0, count)
              .map((channel) => ({ playlist, channel, key: channelKey(playlist.id, channel.id) })),
          );
    const favourites = sources.flatMap((playlist) =>
      playlist.channels
        .filter((c) => current.preferences.favourites.includes(channelKey(playlist.id, c.id)))
        .map((channel) => ({ playlist, channel, key: channelKey(playlist.id, channel.id) })),
    );
    void checkChannels([...favourites, ...targets]).catch(() => {});
  }, [
    state.ready,
    playlistIds,
    events,
    tab,
    count,
    clock,
    profile?.maturity,
    query,
    group,
    favouritesOnly,
    state.preferences.favourites,
  ]);

  useEffect(
    () => () => {
      void cancelChecks().catch(() => {});
    },
    [playlistIds, profile?.id],
  );

  useEffect(() => {
    setCount(60);
    setGroup('all');
  }, [selected]);

  const available = useMemo(
    () =>
      playlists.flatMap((playlist) =>
        playlist.channels.map((channel) => ({ playlist, channel, key: channelKey(playlist.id, channel.id) })),
      ),
    [playlists],
  );
  const groups = [...new Set(available.flatMap((m) => m.channel.group.split(';')))].sort();
  const matchesQuery = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const channels = available.filter(
    (m) =>
      (state.preferences.showUnavailable || m.playlist.health[m.channel.id]?.state !== 'unavailable') &&
      (group === 'all' || m.channel.group.split(';').includes(group)) &&
      (!favouritesOnly || state.preferences.favourites.includes(m.key)) &&
      matchesQuery(`${m.channel.name} ${m.channel.tvgId} ${m.channel.group}`),
  );
  const filteredEvents = events.filter(
    (e) =>
      matchesQuery(
        `${e.name} ${leagueLabel(e.league)} ${e.broadcasts.join(' ')} ${e.teams.map((t) => `${t.name} ${t.abbreviation}`).join(' ')}`,
      ) &&
      (!favouritesOnly || e.teams.some((t) => state.preferences.teams.includes(t.id))),
  );
  const toggleFavourite = (key: string) =>
    void setLivePreferences({
      favourites: state.preferences.favourites.includes(key)
        ? state.preferences.favourites.filter((f) => f !== key)
        : [...state.preferences.favourites, key],
    });
  const stepDay = (step: number) =>
    setDay((old) => {
      const next = new Date(old);
      next.setDate(next.getDate() + step);
      return next;
    });
  const openEvent = (event: SportsEvent) => setSelectedEvent(event);

  if (profile?.maturity !== 'all')
    return (
      <section className="px-[4%] pb-20 pt-32">
        <Radio className="mb-5 h-12 w-12 text-nf-red" />
        <h1 className="text-3xl font-bold">Live TV</h1>
        <p className="mt-4 text-nf-secondary">
          Live channels have no verified age ratings. Switch to an adult profile to use Live TV.
        </p>
      </section>
    );
  return (
    <section className="min-h-screen px-[4%] pb-20 pt-28">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Live TV</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Dropdown
            value={selected || state.playlists[0]?.id || ''}
            options={[
              ...state.playlists.map((p) => ({
                value: p.id,
                label: p.name,
                hint: `${p.channels.length.toLocaleString()} streams`,
              })),
              ...(state.playlists.length > 1 ? [{ value: 'all', label: 'All playlists' }] : []),
            ]}
            onChange={(playlist) => void setLivePreferences({ playlist })}
            ariaLabel="Playlist"
          />
          <button className={button} onClick={() => guardAdult(() => setSourcesOpen(true))}>
            <Settings2 className="h-4 w-4" /> Sources
          </button>
        </div>
      </div>
      <div className="mb-7 flex flex-wrap items-center gap-3 border-b border-white/10 pb-5">
        <div className="mr-3 flex rounded bg-white/5 p-1">
          {(['sports', 'channels'] as const).map((value) => (
            <button
              key={value}
              className={`rounded px-5 py-2 text-sm font-semibold ${tab === value ? 'bg-white text-black' : 'text-nf-secondary hover:text-white'}`}
              onClick={() => setTab(value)}
            >
              {value === 'sports' ? 'Sports' : 'Channels'}
            </button>
          ))}
        </div>
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded border border-white/15 bg-black/30 px-3">
          <Search className="h-4 w-4 text-nf-muted" />
          <input
            aria-label="Search live TV"
            className="w-full bg-transparent py-2.5 text-sm outline-none"
            placeholder={tab === 'sports' ? 'Search teams, events, broadcasters…' : 'Search channels…'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCount(60);
            }}
          />
        </label>
        <button
          className={`${button} ${favouritesOnly ? 'text-yellow-400' : ''}`}
          onClick={() => setFavouritesOnly(!favouritesOnly)}
          aria-pressed={favouritesOnly}
        >
          <Star className={`h-4 w-4 ${favouritesOnly ? 'fill-current' : ''}`} /> Favourites
        </button>
        {tab === 'sports' ? (
          <Dropdown
            value={league}
            options={[{ value: 'all', label: 'All leagues' }, ...LEAGUES.map(([value, label]) => ({ value, label }))]}
            onChange={setLeague}
            ariaLabel="League"
          />
        ) : (
          <Dropdown
            value={group}
            options={[{ value: 'all', label: 'All groups' }, ...groups.map((g) => ({ value: g, label: g }))]}
            onChange={(value) => {
              setGroup(value);
              setCount(60);
            }}
            ariaLabel="Channel group"
          />
        )}
      </div>
      {tab === 'sports' ? (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button className={button} aria-label="Previous day" onClick={() => stepDay(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-36 text-center text-sm font-semibold">{dateLabel(day)}</span>
              <button className={button} aria-label="Next day" onClick={() => stepDay(1)}>
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                className="ml-2 text-xs text-nf-secondary hover:text-white"
                onClick={() => {
                  const d = new Date();
                  d.setHours(12, 0, 0, 0);
                  setDay(d);
                }}
              >
                Today
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {updated > 0 && (
                <span className="text-xs text-nf-muted">
                  Updated {new Date(updated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              <button className={button} disabled={loading} onClick={() => setRefresh((v) => v + 1)}>
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh scores
              </button>
            </div>
          </div>
          {(scheduleError || stale) && (
            <p
              role="status"
              className="mb-5 rounded border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-200"
            >
              {scheduleError || 'Showing saved scores and schedules. Refresh to check for changes.'}
              {updated > 0 && ` Last updated ${new Date(updated).toLocaleString()}.`}
            </p>
          )}
          {!state.playlists.length && (
            <div className="mb-7 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-white/10 bg-gradient-to-r from-nf-red/15 to-white/5 p-6">
              <div>
                <h2 className="text-lg font-bold">Bring your channels</h2>
                <p className="mt-1 text-sm text-nf-secondary">Add an M3U playlist to find streams for these events.</p>
              </div>
              <button className="nf-btn-red" onClick={() => setSourcesOpen(true)}>
                <Plus className="h-4 w-4" /> Add playlist
              </button>
            </div>
          )}
          {loading && !events.length ? (
            <div role="status" className="flex items-center justify-center gap-3 py-20 text-nf-secondary">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading events…
            </div>
          ) : filteredEvents.length ? (
            (['live', 'upcoming', 'finished'] as const).map((status) => {
              const row = filteredEvents.filter((e) => e.status === status);
              return (
                row.length > 0 && (
                  <div key={status} className="mb-9">
                    <h2 className="mb-4 flex items-center gap-2 text-xl font-bold">
                      {status === 'live' && <span className="h-2 w-2 rounded-full bg-nf-red" />}
                      {status === 'live' ? 'Live now' : status === 'upcoming' ? 'Upcoming' : 'Finished'}
                    </h2>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {row.map((event) => (
                        <EventCard
                          key={event.id}
                          event={event}
                          matches={eventMatches(event, playlists, false, state.preferences.matches)}
                          onOpen={() => openEvent(event)}
                        />
                      ))}
                    </div>
                  </div>
                )
              );
            })
          ) : (
            <p className="py-16 text-center text-nf-secondary">
              {query || favouritesOnly
                ? 'No events match your filters.'
                : 'No scheduled events for this league and day. Try another date or league.'}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-nf-secondary">
              {channels.length.toLocaleString()} {channels.length === 1 ? 'channel' : 'channels'} ·{' '}
              {state.checking ? `Checking ${state.checked}/${state.total}` : 'Availability updates in the background'}
            </p>
            <div className="flex gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-nf-secondary">
                <input
                  type="checkbox"
                  checked={state.preferences.showUnavailable}
                  onChange={(e) => void setLivePreferences({ showUnavailable: e.target.checked })}
                />{' '}
                Show unavailable
              </label>
              <button
                className={button}
                disabled={!available.length}
                onClick={() =>
                  void (state.checking ? cancelChecks() : checkChannels(available, true)).catch(() =>
                    toast('Could not check playlist', 'error'),
                  )
                }
              >
                <Activity className="h-4 w-4" /> {state.checking ? 'Stop checking' : 'Check playlist'}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-4">
            {channels.slice(0, count).map((match) => {
              const health = match.playlist.health[match.channel.id];
              return (
                <div
                  key={match.key}
                  className="group flex min-w-0 items-center gap-3 rounded-md border border-white/10 bg-[#202020] p-4 transition hover:border-white/30"
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => void playLive(match, undefined, channels)}
                    aria-label={`Play ${match.channel.name}`}
                  >
                    <LiveArtwork url={match.channel.logo} className="h-12 w-16 rounded bg-black/25 p-1" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold">{match.channel.name}</span>
                      <span className="mt-1 block truncate text-xs text-nf-muted">
                        {match.playlist.name} ·{' '}
                        {health?.state === 'verified'
                          ? 'Played successfully'
                          : health?.state === 'reachable'
                            ? 'Recently reachable'
                            : health?.state === 'unavailable'
                              ? health.reason
                              : health?.state === 'suspect'
                                ? 'Rechecking availability'
                                : 'Not yet verified'}
                      </span>
                    </span>
                  </button>
                  <button
                    aria-label={`Favourite ${match.channel.name}`}
                    aria-pressed={state.preferences.favourites.includes(match.key)}
                    onClick={() => toggleFavourite(match.key)}
                    className="p-1 text-nf-muted hover:text-yellow-400"
                  >
                    <Star
                      className={`h-4 w-4 ${state.preferences.favourites.includes(match.key) ? 'fill-yellow-400 text-yellow-400' : ''}`}
                    />
                  </button>
                  {health?.state === 'unavailable' && (
                    <button
                      title="Retry channel"
                      aria-label={`Retry ${match.channel.name}`}
                      onClick={() => void checkChannels([match], true)}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {!channels.length && (
            <div className="py-16 text-center text-nf-secondary">
              {state.playlists.length
                ? 'No channels match your filters. Try Show unavailable or another playlist.'
                : 'Add a playlist to browse your channels.'}
            </div>
          )}
          {channels.length > count && (
            <button className={`${button} mx-auto mt-6 flex`} onClick={() => setCount((c) => c + 60)}>
              Show more channels
            </button>
          )}
        </>
      )}
      {sourcesOpen && <Sources onClose={() => setSourcesOpen(false)} />}
      {selectedEvent && (
        <EventFeeds
          event={events.find((event) => event.id === selectedEvent.id) ?? selectedEvent}
          playlists={playlists}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </section>
  );
}
