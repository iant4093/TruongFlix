import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async () => {} }) }));
vi.mock('../src/services/db', async (load) => ({ ...(await load<object>()), readLiveData: vi.fn(), writeLiveData: vi.fn(), logLiveViewing: vi.fn() }));

import { checkChannels, importPlaylist, parseWebList, useLiveStore, webPlayerUrl } from '../src/services/live';
import { isPlayingVideo, playLive } from '../src/services/player';
import { useLibraryStore } from '../src/store/useLibraryStore';
import LivePlayer from '../src/components/live/LivePlayer';
import type { LivePlayerSession } from '../src/types/live';

const list = {
  name: 'Example list',
  baseUrl: 'https://tv.example/embed/',
  channels: [
    { id: 'abc-one', name: 'ABC', region: 'US', quality: 'HD', sport: 'football', live: true, url: 'https://tv.example/embed/abc-one' },
    { id: 'from-base', name: 'From base', live: true },
    { id: 'off', name: 'Off air', live: false, url: 'https://tv.example/embed/off' },
    { id: 'plain', name: 'Insecure', url: 'http://tv.example/embed/plain' },
    { id: 'abc-one', name: 'Duplicate', url: 'https://tv.example/embed/abc-one' },
  ],
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLiveStore.setState({ playlists: [], profileId: 1, webPaused: false });
});
afterEach(() => cleanup());

it('reads web channel lists and keeps only HTTPS player links', () => {
  const channels = parseWebList(list);
  expect(channels.map((c) => [c.id, c.web?.url, c.group])).toEqual([
    ['web:abc-one', 'https://tv.example/embed/abc-one', 'football'],
    ['web:from-base', 'https://tv.example/embed/from-base', 'Channels'],
    ['web:off', 'https://tv.example/embed/off', 'Channels'],
  ]);
  expect(channels[0].web).toMatchObject({ region: 'US', quality: 'HD', live: true });
  expect(() => parseWebList({ channels: 'nope' })).toThrow(/channels/);
  expect(() => parseWebList({ channels: [{ id: 'x', url: 'javascript:alert(1)' }] })).toThrow(/HTTPS/);
});

it('styles the web player to match TruongFlix without overriding the list’s own settings', () => {
  const url = new URL(webPlayerUrl('https://tv.example/embed/abc?brand=1'));
  expect(url.searchParams.get('accent')).toBe('e50914');
  expect(url.searchParams.get('title')).toBe('0');
  expect(url.searchParams.get('fullscreen')).toBe('0');
  expect(url.searchParams.get('brand')).toBe('1');
});

it('adds a labeled web source, marks off-air channels and never stream-checks them', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'live_web_list' ? list : cmd === 'live_check_begin' ? 1 : undefined));
  const source = await importPlaylist('My web TV', ' https://tv.example/embed/manifest.json ', undefined, 'web');
  expect(invoke).toHaveBeenCalledWith('live_web_list', { url: 'https://tv.example/embed/manifest.json' });
  expect(source).toMatchObject({ kind: 'web', name: 'My web TV', input: 'https://tv.example/embed/manifest.json' });
  expect(source.health['web:off']).toMatchObject({ state: 'unavailable', reason: 'Off the air' });
  await checkChannels(source.channels.map((channel) => ({ playlist: source, channel, key: channel.id })), true);
  expect(invoke).not.toHaveBeenCalledWith('live_check', expect.anything());
});

it('plays web channels in the web player instead of the native one', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'live_web_list' ? list : undefined));
  const source = await importPlaylist('My web TV', 'https://tv.example/embed/manifest.json', undefined, 'web');
  useLibraryStore.setState({ activeProfile: { id: 1, maturity: 'all' } as never });
  await playLive({ playlist: source, channel: source.channels[0], key: 'k' });
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  expect(session.web).toEqual({ url: 'https://tv.example/embed/abc-one', source: 'My web TV' });
  expect(invoke).not.toHaveBeenCalledWith('player_open', expect.anything());
  expect(isPlayingVideo()).toBe(true);

  render(<LivePlayer session={session} />);
  const frame = screen.getByTitle('ABC live') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-presentation');
  expect(frame.src).toContain('accent=e50914');
  expect(screen.getByText(/My web TV · Web player/)).toBeTruthy();

  act(() => useLiveStore.setState({ webPaused: true }));
  expect(screen.queryByTitle('ABC live')).toBeNull();
  expect(isPlayingVideo()).toBe(false);
});
