import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Globe, Maximize, Monitor, Play, Radio, RefreshCw } from 'lucide-react';
import type { RemoteLive, RemoteLiveChannel, RemoteLiveEvent, RemoteProfile } from './types';
import { api, qs } from './api';
import { errorMessage } from '../lib/errors';

type Who = { id: number; key?: string; profile: RemoteProfile };
type Watching = { channel: RemoteLiveChannel; title: string; subtitle: string };

const timeLabel = (date: string) => new Date(date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Live TV in the browser: today's games with the channels that carry them, and all channels. */
export default function RemoteLiveSection({ who, onAuthError, onPlayedOnPc }: { who: Who; onAuthError: (e: unknown) => void; onPlayedOnPc: () => void }) {
  const [data, setData] = useState<RemoteLive | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'games' | 'channels'>('games');
  const [league, setLeague] = useState('all');
  const [query, setQuery] = useState('');
  const [watching, setWatching] = useState<Watching | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setData(await api<RemoteLive>(`/live${qs({ profile: who.id, key: who.key })}`));
      setError('');
    } catch (e) {
      onAuthError(e);
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  const anyLive = !!data?.events.some((e) => e.status === 'live');
  useEffect(() => {
    void load();
  }, [who.id]);
  useEffect(() => {
    if (watching) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, anyLive ? 30_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [anyLive, watching, who.id]);

  const watch = async (channel: RemoteLiveChannel, event?: RemoteLiveEvent) => {
    setNotice('');
    if (channel.web) return setWatching({ channel, title: channel.name, subtitle: event?.name ?? channel.source });
    try {
      await api('/live/pc', { body: { profile: who.id, key: who.key, playlistId: channel.playlistId, id: channel.id, eventId: event?.id } });
      setNotice(`${channel.name} is playing on the PC.`);
      onPlayedOnPc();
    } catch (e) {
      onAuthError(e);
      setNotice(errorMessage(e));
    }
  };

  const leagues = useMemo(() => [...new Map((data?.events ?? []).map((e) => [e.league, e.leagueLabel])).entries()], [data]);
  const needle = query.trim().toLowerCase();
  const events = (data?.events ?? []).filter(
    (e) => (league === 'all' || e.league === league) &&
      (!needle || `${e.name} ${e.broadcasts.join(' ')} ${e.teams.map((t) => `${t.name} ${t.abbreviation}`).join(' ')}`.toLowerCase().includes(needle)),
  );
  const channels = (data?.channels ?? []).filter((c) => !needle || `${c.name} ${c.group} ${c.source}`.toLowerCase().includes(needle)).slice(0, 200);

  if (watching) return <WebChannelPlayer watching={watching} onBack={() => setWatching(null)} />;
  return (
    <div className="px-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Live TV view" className="flex rounded border border-white/20 bg-black/30 p-1">
          {(['games', 'channels'] as const).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={`rounded px-4 py-1.5 text-sm font-medium ${view === v ? 'bg-white text-black' : 'text-white/70'}`}>
              {v === 'games' ? 'Sports' : 'Channels'}
            </button>
          ))}
        </div>
        {view === 'games' && leagues.length > 1 && (
          <select value={league} onChange={(e) => setLeague(e.target.value)} aria-label="League" className="rounded border border-white/30 bg-[#242424] px-3 py-2 text-sm">
            <option value="all">All leagues</option>
            {leagues.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        )}
        <button onClick={() => void load()} disabled={loading} aria-label="Refresh" className="ml-auto rounded bg-white/10 p-2 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={view === 'games' ? 'Search teams, games, networks' : 'Search channels'}
        aria-label="Search live TV"
        className="mb-4 w-full rounded border border-white/20 bg-black/40 px-4 py-2.5 text-sm outline-none placeholder:text-white/50 focus:border-white/70"
      />
      {notice && <p role="status" className="mb-4 rounded bg-white/10 p-3 text-sm">{notice}</p>}
      {error && <p className="mb-4 text-sm text-nf-red">{error}</p>}
      {data?.partial && <p className="mb-4 text-xs text-amber-200">Some leagues couldn’t be refreshed.</p>}
      {!data && !error && <p className="py-10 text-center text-nf-secondary">Loading…</p>}
      {data && view === 'games' && (
        <>
          {(['live', 'upcoming', 'finished'] as const).map((status) => {
            const row = events.filter((e) => e.status === status);
            if (!row.length) return null;
            return (
              <section key={status} className="mb-6">
                <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
                  {status === 'live' && <span className="h-2 w-2 rounded-full bg-nf-red" />}
                  {status === 'live' ? 'Live now' : status === 'upcoming' ? 'Upcoming' : 'Finished'}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {row.map((e) => <GameCard key={e.id} event={e} onWatch={(c) => void watch(c, e)} />)}
                </div>
              </section>
            );
          })}
          {!events.length && <p className="py-10 text-center text-nf-secondary">No games today{league !== 'all' || needle ? ' match your filters' : ''}.</p>}
        </>
      )}
      {data && view === 'channels' && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => (
            <button key={`${c.playlistId}/${c.id}`} onClick={() => void watch(c)} className="flex min-w-0 items-center gap-3 rounded-md border border-white/10 bg-nf-hover p-3 text-left active:bg-white/10">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10">
                {c.web ? <Play className="h-4 w-4 fill-current" /> : <Monitor className="h-4 w-4" />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">{c.name}</span>
                <span className="flex items-center gap-1 truncate text-xs text-nf-muted">
                  {c.web ? <Globe className="h-3 w-3 shrink-0" /> : <Radio className="h-3 w-3 shrink-0" />}
                  {c.source} · {c.web ? 'Plays here' : 'Plays on the PC'}
                </span>
              </span>
            </button>
          ))}
          {!channels.length && <p className="col-span-full py-10 text-center text-nf-secondary">{data.channels.length ? 'No channels match your search.' : 'Add Live TV sources on the PC to watch channels.'}</p>}
        </div>
      )}
    </div>
  );
}

function GameCard({ event, onWatch }: { event: RemoteLiveEvent; onWatch: (c: RemoteLiveChannel) => void }) {
  const showScores = event.status !== 'upcoming' && !/cancel|postpon/i.test(event.detail);
  const [first, second] = event.teams;
  return (
    <article className="overflow-hidden rounded-md border border-white/10 bg-nf-surface">
      <div className="relative flex items-center justify-center gap-4 bg-gradient-to-br from-white/5 to-black/50 px-4 py-4">
        <div className="absolute -left-10 -top-10 h-32 w-32 rounded-full opacity-20 blur-3xl" style={{ background: first?.color }} />
        <div className="absolute -bottom-10 -right-10 h-32 w-32 rounded-full opacity-20 blur-3xl" style={{ background: second?.color }} />
        {[first, second].map((team, i) =>
          team ? (
            <div key={i} className={`relative flex min-w-0 flex-1 items-center gap-3 ${i === 1 ? 'flex-row-reverse text-right' : ''}`}>
              {team.logo && <img src={team.logo} alt="" className="h-10 w-10 shrink-0 object-contain" loading="lazy" />}
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold tracking-wider" title={team.name}>
                  {team.rank ? <span className="mr-1 text-nf-secondary">{team.rank}</span> : null}
                  {team.abbreviation || team.name}
                </span>
                {showScores && <span className="block text-2xl font-bold tabular-nums">{team.score || '—'}</span>}
              </span>
            </div>
          ) : null,
        )}
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wider text-nf-muted">
          <span>{event.leagueLabel}</span>
          <span className={event.status === 'live' ? 'text-red-400' : ''}>
            {event.status === 'live' ? `● Live${event.detail ? ` · ${event.detail}` : ''}` : event.status === 'finished' ? event.detail || 'Final' : timeLabel(event.date)}
          </span>
        </div>
        <h3 className="text-sm font-bold">{event.name}</h3>
        {event.broadcasts.length > 0 && <p className="text-xs text-nf-secondary">{event.broadcasts.join(', ')}</p>}
        {event.status !== 'finished' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {event.channels.map((c) => (
              <button key={`${c.playlistId}/${c.id}`} onClick={() => onWatch(c)} className="inline-flex max-w-full items-center gap-1.5 rounded bg-white/10 px-3 py-1.5 text-xs font-semibold active:bg-white/20">
                {c.web ? <Play className="h-3 w-3 shrink-0 fill-current" /> : <Monitor className="h-3 w-3 shrink-0" />}
                <span className="truncate">{c.name}</span>
                <span className="shrink-0 font-normal text-nf-muted">{c.web ? 'Watch' : 'On PC'}</span>
              </button>
            ))}
            {!event.channels.length && <span className="text-xs text-nf-muted">No matching channel in your sources</span>}
          </div>
        )}
      </div>
    </article>
  );
}

/** A web channel's player, full screen in the browser. */
function WebChannelPlayer({ watching, onBack }: { watching: Watching; onBack: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="fixed inset-0 z-50 flex flex-col bg-black">
      <header className="flex items-center gap-3 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button onClick={onBack} aria-label="Back to Live TV" className="rounded-full p-2 active:bg-white/10">
          <ArrowLeft className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-nf-red px-1.5 py-0.5 text-[10px] font-bold tracking-widest">LIVE</span>
            <h1 className="truncate font-bold">{watching.title}</h1>
          </div>
          <p className="truncate text-xs text-white/60">{watching.subtitle}</p>
        </div>
        <button onClick={() => void box.current?.requestFullscreen?.().catch(() => {})} aria-label="Full screen" className="rounded-full p-2 active:bg-white/10">
          <Maximize className="h-5 w-5" />
        </button>
      </header>
      <iframe
        title={`${watching.title} live`}
        src={watching.channel.web!}
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        className="min-h-0 w-full flex-1 border-0 bg-black"
      />
    </div>
  );
}
