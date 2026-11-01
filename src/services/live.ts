import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { readLiveData, writeLiveData } from './db';
import { useLibraryStore } from '../store/useLibraryStore';
import type { ChannelHealth, LiveChannel, LivePlaylist, LivePreferences, SportsEvent } from '../types/live';

export const LEAGUES = [
  ['football/nfl', 'NFL'],
  ['football/college-football', 'College football'],
  ['basketball/nba', 'NBA'],
  ['basketball/wnba', 'WNBA'],
  ['basketball/mens-college-basketball', 'College basketball'],
  ['baseball/mlb', 'MLB'],
  ['hockey/nhl', 'NHL'],
  ['soccer/usa.1', 'MLS'],
  ['soccer/eng.1', 'Premier League'],
  ['soccer/uefa.champions', 'Champions League'],
] as const;

export const localDate = (date = new Date()) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
export const channelKey = (playlist: string, channel: string) => `${playlist}/${channel}`;
const defaults = (): LivePreferences => ({
  playlist: '',
  favourites: [],
  teams: [],
  matches: {},
  showUnavailable: false,
});

interface LiveState {
  playlists: LivePlaylist[];
  preferences: LivePreferences;
  profileId: number;
  ready: boolean;
  checking: boolean;
  checked: number;
  total: number;
  playbackError: string;
  set: (patch: Partial<LiveState>) => void;
}
export const useLiveStore = create<LiveState>((set) => ({
  playlists: [],
  preferences: defaults(),
  profileId: 0,
  ready: false,
  checking: false,
  checked: 0,
  total: 0,
  playbackError: '',
  set,
}));

let loadGeneration = 0;
let saveQueue: Promise<unknown> = Promise.resolve();
function persistPlaylists() {
  const value = useLiveStore.getState().playlists;
  const save = saveQueue.catch(() => {}).then(() => writeLiveData('playlists', value));
  saveQueue = save;
  return save;
}
export async function initLive(profileId: number) {
  const generation = ++loadGeneration;
  useLiveStore.setState({ ready: false });
  await saveQueue.catch(() => {});
  const [playlists, preferences] = await Promise.all([
    readLiveData<LivePlaylist[]>('playlists', []),
    readLiveData<LivePreferences>(`profile:${profileId}`, defaults()),
  ]);
  if (generation !== loadGeneration) return;
  useLiveStore.setState({ playlists, preferences: { ...defaults(), ...preferences }, profileId, ready: true });
}
export async function setLivePreferences(patch: Partial<LivePreferences>) {
  const state = useLiveStore.getState();
  const preferences = { ...state.preferences, ...patch };
  useLiveStore.setState({ preferences });
  await writeLiveData(`profile:${state.profileId}`, preferences);
}
export async function importPlaylist(name: string, input: string, existing?: string) {
  const channels = await invoke<LiveChannel[]>('live_import', { input });
  const state = useLiveStore.getState();
  const old = state.playlists.find((p) => p.id === existing);
  const health: Record<string, ChannelHealth> = {};
  for (const channel of channels) {
    const previous = old?.channels.find((c) => c.id === channel.id);
    if (previous && JSON.stringify(previous.transport) === JSON.stringify(channel.transport) && old?.health[channel.id])
      health[channel.id] = old.health[channel.id];
  }
  const playlist: LivePlaylist = {
    id: existing || crypto.randomUUID(),
    name: name.trim() || 'My playlist',
    input,
    channels,
    health,
    updatedAt: Date.now(),
  };
  useLiveStore.setState({ playlists: [...state.playlists.filter((p) => p.id !== playlist.id), playlist] });
  await persistPlaylists();
  await setLivePreferences({ playlist: playlist.id });
  return playlist;
}
export async function removePlaylist(id: string) {
  await cancelChecks();
  const state = useLiveStore.getState();
  const playlists = state.playlists.filter((p) => p.id !== id);
  useLiveStore.setState({ playlists });
  await persistPlaylists();
  if (state.preferences.playlist === id) await setLivePreferences({ playlist: playlists[0]?.id ?? '' });
}

/** Strict aliases preserve network identities: CBS Sports HQ is never a match for CBS. */
const ALIASES: Record<string, string> = {
  fox: 'fox',
  'fox sports 1': 'fs1',
  fs1: 'fs1',
  'fox sports 2': 'fs2',
  fs2: 'fs2',
  espn: 'espn',
  espn2: 'espn2',
  'espn 2': 'espn2',
  espnu: 'espnu',
  'espn u': 'espnu',
  abc: 'abc',
  cbs: 'cbs',
  nbc: 'nbc',
  'nfl network': 'nflnetwork',
  nflnetwork: 'nflnetwork',
  'nba tv': 'nbatv',
  nbatv: 'nbatv',
  'nhl network': 'nhlnetwork',
  nhlnetwork: 'nhlnetwork',
  'nhl net': 'nhlnetwork',
  tnt: 'tnt',
  tbs: 'tbs',
  'sec network': 'secnetwork',
  secnetwork: 'secnetwork',
  'big ten network': 'bigtennetwork',
  btn: 'bigtennetwork',
  'acc network': 'accnetwork',
  accn: 'accnetwork',
};
const normalized = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();
const compactAliases = new Map(Object.entries(ALIASES).map(([alias, key]) => [alias.replace(/ /g, ''), key]));
const channelNetworks = new WeakMap<LiveChannel, string>();
export function broadcasterKey(name: string) {
  const key = normalized(name).replace(/\s+(hd|sd|us|usa)$/, '');
  return ALIASES[key] ?? compactAliases.get(key.replace(/ /g, '')) ?? key.replace(/ /g, '');
}
function identifyBroadcaster(channel: LiveChannel): string {
  const canonical = channel.tvgId.split('@')[0];
  if (canonical.toLowerCase().endsWith('.us')) return broadcasterKey(canonical.slice(0, -3));
  if (/\.[a-z]{2}$/i.test(canonical)) return `foreign:${canonical.toLowerCase()}`;
  const clean = channel.name
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/\b(HD|SD|FHD|UHD|4K)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const exact = broadcasterKey(clean);
  if (Object.values(ALIASES).includes(exact)) return exact;
  // Common affiliate labels, including a call sign, are candidates requiring a regional choice.
  const affiliate = clean.match(/^(ABC|CBS|NBC|FOX)\s+(K[A-Z0-9-]{2,8}|W[A-Z0-9-]{2,8})$/i);
  return affiliate ? affiliate[1].toLowerCase() : exact;
}
export function channelBroadcaster(channel: LiveChannel): string {
  let key = channelNetworks.get(channel);
  if (key == null) {
    key = identifyBroadcaster(channel);
    channelNetworks.set(channel, key);
  }
  return key;
}
export interface ChannelMatch {
  playlist: LivePlaylist;
  channel: LiveChannel;
  key: string;
}
export const eventMappingKey = (event: SportsEvent) =>
  event.broadcasts.length ? event.broadcasts.map(broadcasterKey).sort().join('|') : `event:${event.id}`;
export function eventMatches(
  event: SportsEvent,
  playlists: LivePlaylist[],
  showUnavailable = false,
  mappings: Record<string, string> = {},
): ChannelMatch[] {
  const networks = new Set(event.broadcasts.map(broadcasterKey));
  const manual = mappings[eventMappingKey(event)];
  return playlists.flatMap((playlist) =>
    playlist.channels
      .filter(
        (channel) =>
          (networks.has(channelBroadcaster(channel)) || (!!manual && channelKey(playlist.id, channel.id) === manual)) &&
          (showUnavailable || playlist.health[channel.id]?.state !== 'unavailable'),
      )
      .map((channel) => ({ playlist, channel, key: channelKey(playlist.id, channel.id) })),
  );
}

interface RawTeam {
  id?: string;
  displayName?: string;
  abbreviation?: string;
  color?: string;
  logo?: string;
}
interface RawEvent {
  id?: string;
  name?: string;
  date?: string;
  status?: { type?: { state?: string; completed?: boolean; shortDetail?: string; detail?: string } };
  competitions?: {
    date?: string;
    status?: RawEvent['status'];
    competitors?: { team?: RawTeam; score?: string }[];
    broadcasts?: { names?: string[] }[];
    geoBroadcasts?: { region?: string; lang?: string; media?: { shortName?: string } }[];
  }[];
}
export function parseSports(data: unknown, league: string): SportsEvent[] {
  const events = (data as { events?: RawEvent[] })?.events;
  if (!Array.isArray(events)) throw new Error('Sports provider returned an invalid schedule');
  return events.flatMap((event) => {
    const competition = event.competitions?.[0];
    const date = competition?.date ?? event.date ?? '';
    if (!event.id || !event.name || !Number.isFinite(Date.parse(date))) return [];
    const status = competition?.status?.type ?? event.status?.type;
    const regional = competition?.geoBroadcasts
      ?.filter((b) => b.region?.toLowerCase() === 'us' && (!b.lang || b.lang === 'en'))
      .map((b) => b.media?.shortName)
      .filter((b): b is string => !!b);
    const broadcasts = regional?.length ? regional : (competition?.broadcasts?.flatMap((b) => b.names ?? []) ?? []);
    return [
      {
        id: `espn:${league}:${event.id}`,
        name: event.name,
        league,
        sport: league.split('/')[0],
        date,
        status:
          status?.completed || status?.state === 'post'
            ? ('finished' as const)
            : status?.state === 'in'
              ? ('live' as const)
              : ('upcoming' as const),
        detail: status?.shortDetail || status?.detail || '',
        broadcasts: [...new Set(broadcasts)],
        teams: (competition?.competitors ?? []).map(({ team, score }) => ({
          id: `${league}:${team?.id ?? team?.displayName}`,
          name: team?.displayName ?? '',
          abbreviation: team?.abbreviation ?? '',
          score: score ?? '',
          color: /^[0-9a-f]{6}$/i.test(team?.color ?? '') ? `#${team!.color}` : '#303030',
          logo: team?.logo ?? '',
        })),
      },
    ];
  });
}

const schedules = new Map<string, Promise<{ events: SportsEvent[]; stale: boolean; fetchedAt: number }>>();
export function sportsSchedule(league: string, date: string, force = false) {
  const key = `${league}:${date}`;
  if (schedules.has(key)) return schedules.get(key)!;
  const promise = (async () => {
    const old = await readLiveData<{ events: SportsEvent[]; fetchedAt: number } | null>(`sports:${key}`, null);
    if (!force && old && Date.now() - old.fetchedAt < (old.events.some((e) => e.status === 'live') ? 60_000 : 600_000))
      return { ...old, stale: false };
    try {
      const data = await invoke<unknown>('live_sports', { league, date });
      const next = { events: parseSports(data, league), fetchedAt: Date.now() };
      await writeLiveData(`sports:${key}`, next);
      return { ...next, stale: false };
    } catch (error) {
      if (old) return { ...old, stale: true };
      throw error;
    }
  })().finally(() => schedules.delete(key));
  schedules.set(key, promise);
  return promise;
}

interface CheckResult {
  state: 'reachable' | 'failed' | 'unknown' | 'rate_limited' | 'cancelled';
  reason: string;
  retryAfter: number;
}
export function applyHealth(
  previous: ChannelHealth | undefined,
  result: CheckResult,
  now = Date.now(),
): ChannelHealth | undefined {
  if (result.state === 'cancelled') return previous;
  if (result.state === 'reachable')
    return {
      state: previous?.state === 'verified' ? 'verified' : 'reachable',
      reason: '',
      checkedAt: now,
      retryAt: now + 30 * 60_000,
      failures: 0,
    };
  if (result.state !== 'failed')
    return {
      state: previous?.state ?? 'unknown',
      failures: previous?.failures ?? 0,
      checkedAt: now,
      retryAt: now + Math.max(60, result.retryAfter || 300) * 1000,
      reason: result.reason,
    };
  const failures = (previous?.failures ?? 0) + 1;
  return {
    state: failures >= 2 ? 'unavailable' : 'suspect',
    reason: result.reason,
    checkedAt: now,
    failures,
    retryAt: now + [30_000, 300_000, 900_000, 3_600_000][Math.min(failures - 1, 3)],
  };
}
function setHealth(playlistId: string, channelId: string, health: ChannelHealth) {
  useLiveStore.setState((s) => ({
    playlists: s.playlists.map((p) =>
      p.id === playlistId ? { ...p, health: { ...p.health, [channelId]: health } } : p,
    ),
  }));
}
let scan = 0;
export async function cancelChecks() {
  scan++;
  useLiveStore.setState({ checking: false });
  await invoke('live_check_begin');
}
export async function checkChannels(matches: ChannelMatch[], force = false) {
  const ticket = ++scan;
  const generation = await invoke<number>('live_check_begin');
  if (ticket !== scan) return;
  const queue = [...new Map(matches.map((m) => [m.key, m])).values()].filter(
    ({ playlist, channel }) =>
      force || !playlist.health[channel.id] || playlist.health[channel.id].retryAt <= Date.now(),
  );
  if (!queue.length) return;
  useLiveStore.setState({ checking: true, checked: 0, total: queue.length });
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && ticket === scan) {
          const match = queue.shift()!;
          if (navigator.onLine === false) break;
          const target = useLibraryStore.getState().playerSession?.target;
          if (target?.type === 'live') {
            const active = useLiveStore
              .getState()
              .playlists.find((p) => p.id === target.playlistId)
              ?.channels.find((c) => c.id === target.id);
            if (active && new URL(active.transport.url).host === new URL(match.channel.transport.url).host) continue;
          }
          const response = await invoke<CheckResult>('live_check', {
            transport: match.channel.transport,
            generation,
          }).catch(() => ({ state: 'unknown' as const, reason: 'Check unavailable', retryAfter: 300 }));
          if (ticket !== scan) return;
          const current = useLiveStore.getState().playlists.find((p) => p.id === match.playlist.id);
          if (
            JSON.stringify(current?.channels.find((c) => c.id === match.channel.id)?.transport) !==
            JSON.stringify(match.channel.transport)
          )
            continue;
          const next = applyHealth(current?.health[match.channel.id], response);
          if (next) setHealth(match.playlist.id, match.channel.id, next);
          useLiveStore.setState((s) => ({ checked: s.checked + 1 }));
        }
      }),
    );
  } finally {
    if (ticket === scan) useLiveStore.setState({ checking: false });
    await persistPlaylists();
  }
}
export function verifiedChannel(playlistId: string, channelId: string) {
  setHealth(playlistId, channelId, {
    state: 'verified',
    checkedAt: Date.now(),
    retryAt: Date.now() + 30 * 60_000,
    failures: 0,
    reason: '',
  });
  void persistPlaylists();
}

const artwork = new Map<string, Promise<string>>();
export function liveArtwork(url: string) {
  if (!/^https?:\/\//.test(url)) return Promise.reject(new Error('No artwork'));
  if (!artwork.has(url)) {
    if (artwork.size >= 256) artwork.delete(artwork.keys().next().value!);
    artwork.set(
      url,
      invoke<string>('live_artwork', { url })
        .then(convertFileSrc)
        .catch((error) => {
          artwork.delete(url);
          throw error;
        }),
    );
  }
  return artwork.get(url)!;
}
