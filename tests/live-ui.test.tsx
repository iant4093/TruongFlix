import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import LiveTV from '../src/components/live/LiveTV';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { useLiveStore } from '../src/services/live';
import { playLive } from '../src/services/player';
import * as db from '../src/services/db';
import type { LivePlaylist } from '../src/types/live';
import type { Profile } from '../src/types/media';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (s: string) => s }));
vi.mock('../src/services/db', () => ({ readLiveData: vi.fn(), writeLiveData: vi.fn() }));
vi.mock('../src/services/player', () => ({ playLive: vi.fn() }));

let playlist: LivePlaylist;
const scoreboard = (state = 'in', score = '14', otherScore = '0', detail = '6:13 - 3rd') => ({
  events: [{
    id: '1', name: '49ers at Rams', date: new Date().toISOString(),
    competitions: [{
      status: { type: { state, completed: state === 'post', shortDetail: detail } },
      broadcasts: [{ names: ['Fox'] }],
      competitors: [
        { team: { id: '25', displayName: 'San Francisco 49ers', abbreviation: 'SF' }, score },
        { team: { id: '14', displayName: 'Los Angeles Rams', abbreviation: 'LAR' }, score: otherScore },
      ],
    }],
  }],
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState({ activeProfile: { id: 1, maturity: 'all', name: 'Adult' } as Profile });
  useLiveStore.setState(useLiveStore.getInitialState(), true);
  playlist = {
    id: 'one',
    name: 'My playlist',
    input: '',
    updatedAt: 1,
    channels: [
      {
        id: 'custom',
        tvgId: '',
        name: 'Provider Seven',
        group: 'General',
        logo: '',
        transport: { url: 'https://example.org/seven.m3u8', userAgent: '', referrer: '' },
      },
      {
        id: 'broken',
        tvgId: 'NBC.us@SD',
        name: 'Broken NBC',
        group: 'General',
        logo: '',
        transport: { url: 'https://example.org/broken.m3u8', userAgent: '', referrer: '' },
      },
    ],
    health: {
      broken: {
        state: 'unavailable',
        checkedAt: Date.now(),
        retryAt: Date.now() + 60_000,
        reason: 'HTTP 404',
        failures: 2,
      },
    },
  };
  vi.mocked(db.readLiveData).mockImplementation(async (key, fallback) => (key === 'playlists' ? [playlist] : fallback));
  vi.mocked(db.writeLiveData).mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'live_check_begin') return 1 as never;
    if (command === 'live_check') return { state: 'unknown', reason: 'Untested', retryAfter: 300 } as never;
    if (command === 'live_sports')
      return {
        events: [
          {
            id: '1',
            name: '49ers at Rams',
            date: new Date().toISOString(),
            competitions: [{ broadcasts: [{ names: ['Fox'] }], competitors: [] }],
          },
        ],
      } as never;
    return undefined as never;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps unavailable channels reversible and saves channel favourites', async () => {
  render(<LiveTV />);
  await waitFor(() => expect(useLiveStore.getState().ready).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Channels', exact: true }));
  expect(screen.getByRole('button', { name: 'Play Provider Seven' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Play Broken NBC' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show unavailable' }));
  expect(screen.getByRole('button', { name: 'Play Broken NBC' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Favourite Provider Seven' }));
  fireEvent.click(screen.getByRole('button', { name: 'Favourites', exact: true }));
  expect(screen.queryByRole('button', { name: 'Play Broken NBC' })).toBeNull();
  expect(useLiveStore.getState().preferences.favourites).toEqual(['one/custom']);
});

it('finds an event by team and saves an explicit mapping to a custom channel', async () => {
  render(<LiveTV />);
  await screen.findByRole('button', { name: /49ers at Rams Fox/ });
  fireEvent.change(screen.getByRole('textbox', { name: 'Search live TV' }), { target: { value: '49ers' } });
  fireEvent.click(screen.getByRole('button', { name: /49ers at Rams Fox/ }));
  expect(screen.getByText(/No available channel in the selected playlist/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose any channel' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a channel to match' }), { target: { value: 'Provider' } });
  fireEvent.click(screen.getByRole('button', { name: 'Choose Provider Seven from My playlist' }));
  expect(playLive).not.toHaveBeenCalled();
  expect(screen.getAllByRole('button', { name: 'Watch channel', exact: true })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /Watch channel/ }));
  await waitFor(() => expect(playLive).toHaveBeenCalled());
  expect(useLiveStore.getState().preferences.matches.fox).toBe('one/custom');
  expect(playLive).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'one/custom' }),
    expect.objectContaining({ name: '49ers at Rams' }),
    expect.any(Array),
  );
});

it('imports pasted source text through the native importer', async () => {
  render(<LiveTV />);
  await waitFor(() => expect(useLiveStore.getState().ready).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Playlist name' }), { target: { value: 'New source' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Playlist URL, stream URL or M3U text' }), {
    target: { value: '#EXTM3U\nhttps://example.org/live.m3u8' },
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'live_import' ? playlist.channels : (2 as never),
  );
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add playlist', exact: true }));
  await waitFor(() => expect(useLiveStore.getState().playlists.some((p) => p.name === 'New source')).toBe(true));
  expect(invoke).toHaveBeenCalledWith('live_import', { input: '#EXTM3U\nhttps://example.org/live.m3u8' });
});

it('keeps unrated channels out of restricted profile views', () => {
  useLibraryStore.setState({ activeProfile: { id: 2, maturity: 'kids', name: 'Kids' } as Profile });
  render(<LiveTV />);
  expect(screen.getByText(/Switch to an adult profile/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sources' })).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith('live_sports', expect.anything());
});

it.each([
  ['in', '14', '0', '6:13 - 3rd', true],
  ['post', '17', '0', 'Final/OT', true],
  ['pre', '0', '0', '8:20 PM', false],
  ['post', '0', '0', 'Canceled', false],
] as const)('shows appropriate scores for %s games (%s–%s, %s)', async (state, first, second, detail, show) => {
  vi.mocked(invoke).mockResolvedValue(scoreboard(state, first, second, detail) as never);
  render(<LiveTV />);
  await screen.findByText('49ers at Rams');
  if (show) {
    expect(screen.getByLabelText(`San Francisco 49ers score: ${first}`).textContent).toBe(first);
    expect(screen.getByLabelText(`Los Angeles Rams score: ${second}`).textContent).toBe(second);
    expect(screen.getByText(new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
  } else expect(screen.queryByLabelText(/score:/)).toBeNull();
});

it('shows unavailable scores as dashes, not zeroes', async () => {
  vi.mocked(invoke).mockResolvedValue(scoreboard('in', '', '', 'Halftime') as never);
  render(<LiveTV />);
  expect((await screen.findByLabelText('San Francisco 49ers score: unavailable')).textContent).toBe('—');
  expect(screen.getByLabelText('Los Angeles Rams score: unavailable').textContent).toBe('—');
});

it('updates live cards and the open channel picker in place and preserves stale scores offline', async () => {
  vi.useFakeTimers();
  const saved = new Map<string, unknown>();
  vi.mocked(db.readLiveData).mockImplementation(async (key, fallback) => saved.get(key) ?? fallback);
  vi.mocked(db.writeLiveData).mockImplementation(async (key, value) => { saved.set(key, value); });
  let response = scoreboard();
  let pending: Promise<typeof response> | null = null;
  vi.mocked(invoke).mockImplementation(async (command) => command === 'live_sports' ? (pending ?? response) as never : undefined as never);
  render(<LiveTV />);
  await act(async () => { await Promise.resolve(); });
  const card = screen.getByText('49ers at Rams').closest('button')!;
  fireEvent.click(card);
  expect(within(screen.getByRole('dialog')).getByLabelText('San Francisco 49ers score: 14')).toBeTruthy();
  response = scoreboard('in', '21', '7', '2:40 - 3rd');
  let finish!: (value: typeof response) => void;
  pending = new Promise((resolve) => { finish = resolve; });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(card.isConnected).toBe(true);
  expect(screen.getAllByLabelText('San Francisco 49ers score: 14')).toHaveLength(2);
  expect((screen.getByRole('button', { name: 'Refresh scores' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finish(response); });
  pending = null;
  expect(screen.getByRole('heading', { level: 3, name: '49ers at Rams' }).closest('button')).toBe(card);
  expect(screen.getAllByLabelText('San Francisco 49ers score: 21')).toHaveLength(2);
  expect(screen.getAllByText('● Live · 2:40 - 3rd')).toHaveLength(2);
  vi.mocked(invoke).mockRejectedValue(new Error('Offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getAllByLabelText('San Francisco 49ers score: 21')).toHaveLength(2);
  expect(screen.getByText(/Showing saved scores and schedules/)).toBeTruthy();
});

it('pauses score polling in Channels, while hidden, and during playback, then refreshes on return', async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.mocked(invoke).mockResolvedValue(scoreboard() as never);
  render(<LiveTV />);
  await act(async () => { await Promise.resolve(); });
  const requests = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'live_sports').length;
  expect(requests()).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Channels', exact: true }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(requests()).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Sports', exact: true }));
  await act(async () => { await Promise.resolve(); });
  expect(requests()).toBe(2);
  hidden = true;
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(requests()).toBe(2);
  hidden = false;
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => { await Promise.resolve(); });
  expect(requests()).toBe(3);
  act(() => useLibraryStore.setState({ playerSession: { itemKey: null } as never }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(requests()).toBe(3);
  act(() => useLibraryStore.setState({ playerSession: null }));
  await act(async () => { await Promise.resolve(); });
  expect(requests()).toBe(4);
});
