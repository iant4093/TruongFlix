import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import * as db from '../src/services/db';
import {
  applyHealth,
  cancelChecks,
  checkChannels,
  eventMatches,
  importPlaylist,
  initLive,
  parseSports,
  setLivePreferences,
  sportsSchedule,
  useLiveStore,
} from '../src/services/live';
import type { LiveChannel, LivePlaylist, SportsEvent } from '../src/types/live';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (s: string) => s }));
vi.mock('../src/services/db', () => ({ readLiveData: vi.fn(), writeLiveData: vi.fn() }));

const channel = (id: string, tvgId: string, name = tvgId): LiveChannel => ({
  id,
  tvgId,
  name,
  logo: '',
  group: 'General',
  transport: { url: `https://example.org/${id}.m3u8`, referrer: '', userAgent: '' },
});
const source = (id: string, channels: LiveChannel[]): LivePlaylist => ({
  id,
  name: id,
  input: 'https://example.org/list.m3u',
  channels,
  health: {},
  updatedAt: 1,
});
const event: SportsEvent = {
  id: 'game',
  name: '49ers at Rams',
  league: 'football/nfl',
  sport: 'football',
  date: '2026-11-01T18:00:00Z',
  status: 'upcoming',
  detail: '',
  broadcasts: ['Fox'],
  teams: [],
};
const api = {
  events: [
    {
      id: '1',
      name: '49ers at Rams',
      date: '2026-11-01T18:00:00Z',
      competitions: [
        {
          status: { type: { state: 'in', shortDetail: 'Q2' } },
          competitors: [{ team: { id: '25', displayName: 'San Francisco 49ers', abbreviation: 'SF' }, score: '14' }],
          broadcasts: [{ names: ['FOX', 'Wrong international feed'] }],
          geoBroadcasts: [
            { region: 'us', lang: 'en', media: { shortName: 'Fox' } },
            { region: 'ca', media: { shortName: 'TSN' } },
          ],
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  useLiveStore.setState(useLiveStore.getInitialState(), true);
  vi.mocked(db.readLiveData).mockImplementation(async (_key, fallback) => fallback);
  vi.mocked(db.writeLiveData).mockResolvedValue(undefined);
  vi.mocked(invoke).mockResolvedValue(undefined as never);
});

describe('event discovery and feed matching', () => {
  it('normalizes live status, teams, scores and US broadcaster metadata', () => {
    const parsed = parseSports(api, 'football/nfl')[0];
    expect(parsed.status).toBe('live');
    expect(parsed.broadcasts).toEqual(['Fox']);
    expect(parsed.teams[0]).toMatchObject({ name: 'San Francisco 49ers', score: '14', id: 'football/nfl:25' });
  });
  it('keeps zero scores and normalizes numeric scores without inventing missing or invalid ones', () => {
    const parsed = parseSports({ events: [{
      ...api.events[0],
      competitions: [{ competitors: [
        { team: { id: '1' }, score: 0 },
        { team: { id: '2' }, score: ' 17 ' },
        { team: { id: '3' } },
        { team: { id: '4' }, score: 'NaN' },
        { team: { id: '5' }, score: { value: 9 } },
      ] }],
    }] }, 'football/nfl')[0];
    expect(parsed.teams.map((team) => team.score)).toEqual(['0', '17', '', '', '']);
  });
  it('rejects invalid provider payloads and skips malformed events', () => {
    expect(() => parseSports({}, 'football/nfl')).toThrow();
    expect(parseSports({ events: [{ id: '1', name: 'Invalid date', date: 'no' }] }, 'football/nfl')).toEqual([]);
  });
  it('matches regional general-category affiliates across playlists without picking CBS Sports HQ', () => {
    const cbsEvent = { ...event, broadcasts: ['CBS'] };
    const sources = [
      source('one', [channel('cbs', 'CBS.us@KPIXTV'), channel('hq', 'CBSSportsHQ.us@SD')]),
      source('two', [channel('cbs', 'CBS.us@KIROTV')]),
    ];
    expect(eventMatches(cbsEvent, sources).map((m) => m.key)).toEqual(['one/cbs', 'two/cbs']);
  });
  it('keeps ESPN2, ESPN Deportes and ESPN+ distinct from ESPN', () => {
    const sources = [
      source('one', [
        channel('espn', 'ESPN.us@HD'),
        channel('two', 'ESPN2.us@HD'),
        channel('deportes', 'ESPNDeportes.us@SD'),
      ]),
    ];
    expect(eventMatches({ ...event, broadcasts: ['ESPN'] }, sources).map((m) => m.channel.id)).toEqual(['espn']);
    expect(eventMatches({ ...event, broadcasts: ['ESPN+'] }, sources)).toHaveLength(0);
  });
  it('matches names and aliases for playlists without tvg IDs', () => {
    expect(
      eventMatches({ ...event, broadcasts: ['FS1'] }, [source('one', [channel('fs1', 'FoxSports1.us@HD')])]),
    ).toHaveLength(1);
    expect(
      eventMatches({ ...event, broadcasts: ['FS1'] }, [source('one', [channel('fs1', '', 'Fox Sports 1 (720p)')])]),
    ).toHaveLength(1);
    expect(eventMatches(event, [source('one', [channel('local', '', 'FOX KTVU HD')])])).toHaveLength(1);
  });
  it('hides a failed feed independently and reveals it on request', () => {
    const one = source('one', [channel('local', 'Fox.us@KTVU')]);
    one.health.local = { state: 'unavailable', reason: 'HTTP 404', checkedAt: 1, retryAt: 2, failures: 2 };
    const two = source('two', [channel('local', 'Fox.us@KTVU')]);
    expect(eventMatches(event, [one, two]).map((m) => m.playlist.id)).toEqual(['two']);
    expect(eventMatches(event, [one, two], true)).toHaveLength(2);
  });
  it('preserves an explicit manual mapping for a provider-specific channel name', () => {
    const custom = source('custom', [channel('local', '', 'My regional feed 7')]);
    expect(eventMatches(event, [custom])).toHaveLength(0);
    expect(eventMatches(event, [custom], false, { fox: 'custom/local' })).toHaveLength(1);
  });
  it('does not automatically treat a foreign feed with the same name as a US broadcaster', () => {
    expect(eventMatches(event, [source('foreign', [channel('fox', 'Fox.uk@SD', 'Fox HD')])])).toHaveLength(0);
  });
});

describe('availability filtering', () => {
  it('requires repeated stream-specific failures and restores recovered channels', () => {
    const failure = { state: 'failed' as const, reason: 'HTTP 404', retryAfter: 0 };
    const first = applyHealth(undefined, failure, 1000)!;
    expect(first.state).toBe('suspect');
    const second = applyHealth(first, failure, 2000)!;
    expect(second.state).toBe('unavailable');
    expect(applyHealth(second, { state: 'reachable', reason: '', retryAfter: 0 }, 3000)).toMatchObject({
      state: 'reachable',
      failures: 0,
      reason: '',
    });
  });
  it.each(['unknown', 'rate_limited', 'cancelled'] as const)(
    '%s never turns an untested channel into a hidden one',
    (state) => {
      expect(applyHealth(undefined, { state, reason: 'Try later', retryAfter: 900 }, 1000)?.state).not.toBe(
        'unavailable',
      );
    },
  );
  it('preserves successful playback evidence during transient network errors', () => {
    const verified = { state: 'verified' as const, reason: '', checkedAt: 1, retryAt: 2, failures: 0 };
    expect(applyHealth(verified, { state: 'unknown', reason: 'Offline', retryAfter: 0 })?.state).toBe('verified');
    expect(applyHealth(verified, { state: 'rate_limited', reason: 'Slow down', retryAfter: 600 }, 1000)?.retryAt).toBe(
      601000,
    );
  });
  it('discards a late check when the playlist is switched', async () => {
    const playlist = source('one', [channel('fox', 'Fox.us@SD')]);
    useLiveStore.setState({ playlists: [playlist] });
    let resolve!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'live_check'
        ? new Promise((r) => {
            resolve = r;
          })
        : (1 as never),
    );
    const running = checkChannels([{ playlist, channel: playlist.channels[0], key: 'one/fox' }]);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await cancelChecks();
    resolve({ state: 'failed', reason: 'HTTP 404', retryAfter: 0 });
    await running;
    expect(useLiveStore.getState().playlists[0].health).toEqual({});
  });
});

describe('source persistence and schedule caching', () => {
  it('preserves last-good channels on failed refresh and clears failures after URL changes', async () => {
    const playlist = source('one', [channel('fox', 'Fox.us@SD')]);
    playlist.health.fox = { state: 'unavailable', reason: 'HTTP 404', checkedAt: 1, retryAt: 2, failures: 2 };
    useLiveStore.setState({ playlists: [playlist] });
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Offline'));
    await expect(importPlaylist('One', 'https://new.example/list.m3u', 'one')).rejects.toThrow();
    expect(useLiveStore.getState().playlists[0]).toEqual(playlist);
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        ...playlist.channels[0],
        transport: { ...playlist.channels[0].transport, url: 'https://new.example/fox.m3u8' },
      },
    ]);
    await importPlaylist('One', 'https://new.example/list.m3u', 'one');
    expect(useLiveStore.getState().playlists[0].health).toEqual({});
  });
  it('loads separate favourites and feed choices for each profile', async () => {
    vi.mocked(db.readLiveData).mockImplementation(async (key, fallback) =>
      key === 'profile:2'
        ? { playlist: 'two', favourites: ['two/fox'], teams: [], matches: {}, showUnavailable: true }
        : fallback,
    );
    await initLive(2);
    expect(useLiveStore.getState().preferences.favourites).toEqual(['two/fox']);
    await initLive(1);
    expect(useLiveStore.getState().preferences.favourites).toEqual([]);
    await setLivePreferences({ playlist: 'one' });
    expect(db.writeLiveData).toHaveBeenLastCalledWith('profile:1', expect.objectContaining({ playlist: 'one' }));
  });
  it('uses saved schedules without a new request and returns stale data when the API fails', async () => {
    const old = { events: [event], fetchedAt: Date.now() };
    vi.mocked(db.readLiveData).mockResolvedValue(old);
    expect((await sportsSchedule('football/nfl', '20261101')).stale).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValue(new Error('Offline'));
    const response = await sportsSchedule('football/nfl', '20261101', true);
    expect(response.stale).toBe(true);
    expect(response.events).toEqual([event]);
  });
  it('refreshes live scores after 30 seconds and today’s upcoming schedules after a minute', async () => {
    const now = Date.now();
    const date = new Date();
    const today = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const old = { events: [{ ...event, status: 'live' }], fetchedAt: now - 20_000 };
    vi.mocked(db.readLiveData).mockResolvedValue(old);
    vi.mocked(invoke).mockResolvedValue(api as never);
    await sportsSchedule('football/nfl', today);
    expect(invoke).not.toHaveBeenCalled();
    old.fetchedAt = now - 31_000;
    await sportsSchedule('football/nfl', today);
    expect(invoke).toHaveBeenCalledTimes(1);
    old.events[0].status = 'upcoming';
    await sportsSchedule('football/nfl', today);
    expect(invoke).toHaveBeenCalledTimes(1);
    old.fetchedAt = now - 61_000;
    await sportsSchedule('football/nfl', today);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
