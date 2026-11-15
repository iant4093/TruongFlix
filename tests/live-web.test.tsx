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

const m3u = {
  id: 'm3u',
  name: 'My M3U',
  input: 'x',
  updatedAt: 0,
  health: {},
  channels: [{ id: 'espn', tvgId: '', name: 'ESPN', logo: '', group: 'Sports', transport: { url: 'https://cdn.example/espn.m3u8', referrer: '', userAgent: '' } }],
};
const nativeOpens = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'player_open').map(([, a]) => (a as { filePath: string }).filePath);

async function webSource() {
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === 'live_web_list' ? list : cmd === 'player_status' ? { available: true } : undefined);
  const source = await importPlaylist('My web TV', 'https://tv.example/embed/manifest.json', undefined, 'web');
  useLiveStore.setState({ playlists: [source, m3u] });
  useLibraryStore.setState({ activeProfile: { id: 1, maturity: 'all' } as never });
  return source;
}

it('shows a web channel and an M3U channel together, with the native player on the M3U side', async () => {
  const source = await webSource();
  await playLive({ playlist: source, channel: source.channels[0], key: 'a' }, undefined, undefined, [
    { match: { playlist: m3u, channel: m3u.channels[0], key: 'b' } },
  ]);
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  expect(session.web?.url).toBe('https://tv.example/embed/abc-one');
  expect(session.multiview).toMatchObject({ title: 'ESPN' });
  expect(session.multiview?.web).toBeUndefined();
  expect(nativeOpens()).toEqual(['https://cdn.example/espn.m3u8']);

  render(<LivePlayer session={session} />);
  const frame = screen.getByTitle('ABC live') as HTMLIFrameElement;
  expect(frame.src).not.toContain('muted=1');
  expect(screen.getByText(/Web player/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith('player_multiview_open', expect.anything());
});

it('shows two web channels with only the chosen one heard and no native player', async () => {
  const source = await webSource();
  await playLive({ playlist: source, channel: source.channels[0], key: 'a' }, undefined, undefined, [
    { match: { playlist: source, channel: source.channels[1], key: 'b' } },
  ]);
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  expect(session.multiview?.web?.url).toBe('https://tv.example/embed/from-base');
  expect(nativeOpens()).toEqual([]);
  render(<LivePlayer session={session} />);
  expect((screen.getByTitle('ABC live') as HTMLIFrameElement).src).not.toContain('muted=1');
  expect((screen.getByTitle('From base live') as HTMLIFrameElement).src).toContain('muted=1');
  act(() => screen.getByLabelText('Listen to From base').click());
  expect((screen.getByTitle('ABC live') as HTMLIFrameElement).src).toContain('muted=1');
  expect((screen.getByTitle('From base live') as HTMLIFrameElement).src).not.toContain('muted=1');
});

it('keeps a web channel playing in the mini player', async () => {
  const source = await webSource();
  await playLive({ playlist: source, channel: source.channels[0], key: 'a' });
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  render(<LivePlayer session={session} />);
  const before = screen.getByTitle('ABC live');
  await act(async () => {
    const { enterMini } = await import('../src/services/player');
    await enterMini();
  });
  expect(useLibraryStore.getState().playerMini).toBe(true);
  expect(screen.getByTitle('ABC live')).toBe(before);
  expect(before.className).toContain('fixed');
  expect(invoke).not.toHaveBeenCalledWith('player_layout', expect.anything());
});

it('shows the web player above the mini player frame', async () => {
  const source = await webSource();
  await playLive({ playlist: source, channel: source.channels[0], key: 'a' });
  useLibraryStore.setState({ playerMini: true });
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  const { container } = render(<LivePlayer session={session} />);
  // The mini player's frame is z-120; the layer holding the web player must be above it.
  expect((container.firstElementChild as HTMLElement).className).toContain('z-[121]');
});

it('shows four channels with at most two native ones', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const source = await webSource();
  const m3u2 = { ...m3u, id: 'm3u2', channels: [{ ...m3u.channels[0], id: 'fox', name: 'FOX', transport: { ...m3u.channels[0].transport, url: 'https://cdn.example/fox.m3u8' } }] };
  const m3u3 = { ...m3u, id: 'm3u3', channels: [{ ...m3u.channels[0], id: 'cbs', name: 'CBS', transport: { ...m3u.channels[0].transport, url: 'https://cdn.example/cbs.m3u8' } }] };
  useLiveStore.setState({ playlists: [source, m3u, m3u2, m3u3] });
  const feed = (playlist: typeof m3u, i = 0) => ({ match: { playlist, channel: playlist.channels[i], key: `${playlist.id}/${i}` } });
  const { playLiveMultiview } = await import('../src/services/player');
  await playLiveMultiview([feed(m3u), feed(m3u2), feed(m3u3), feed(source as never)]);
  expect(useLibraryStore.getState().playerSession).toBeNull();
  await playLiveMultiview([feed(source as never), feed(m3u), feed(source as never, 1), feed(m3u2)]);
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  expect([session.title, session.multiview?.title, ...(session.more ?? []).map((p) => p.title)]).toEqual(['ABC', 'ESPN', 'From base', 'FOX']);
  expect(nativeOpens()).toEqual(['https://cdn.example/espn.m3u8']);
  render(<LivePlayer session={session} />);
  expect(screen.getByTitle('ABC live')).toBeTruthy();
  expect(screen.getByTitle('From base live')).toBeTruthy();
  expect(screen.getByLabelText('Listen to FOX')).toBeTruthy();
});

it('hides multiview controls and the cursor when the mouse rests', async () => {
  vi.useFakeTimers();
  try {
    const source = await webSource();
    await playLive({ playlist: source, channel: source.channels[0], key: 'a' }, undefined, undefined, [
      { match: { playlist: source, channel: source.channels[1], key: 'b' } },
    ]);
    const session = useLibraryStore.getState().playerSession as LivePlayerSession;
    render(<LivePlayer session={session} />);
    const view = screen.getByLabelText('Live TV multiview');
    expect(view.className).not.toContain('cursor-none');
    act(() => vi.advanceTimersByTime(3500));
    expect(view.className).toContain('cursor-none');
    expect(screen.getByRole('banner').className).toContain('opacity-0');
    act(() => { view.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); });
    expect(view.className).not.toContain('cursor-none');
  } finally {
    vi.useRealTimers();
  }
});

it('matches shortened broadcaster names to channel names', async () => {
  const { broadcasterKey, channelBroadcaster } = await import('../src/services/live');
  const named = (name: string) => ({ ...m3u.channels[0], name });
  expect(broadcasterKey('USA Net')).toBe('usanetwork');
  expect(channelBroadcaster(named('USA Network'))).toBe('usanetwork');
  expect(channelBroadcaster(named('USA Network FHD'))).toBe('usanetwork');
  expect(channelBroadcaster(named('USA Network East'))).toBe('usanetwork');
  expect(broadcasterKey('CBS Sports Net')).toBe('cbssportsnetwork');
  expect(broadcasterKey('NHL Net')).toBe('nhlnetwork');
  expect(broadcasterKey('ESPN 2')).toBe('espn2');
  expect(broadcasterKey('CBS Sports HQ')).not.toBe('cbs');
});

it('starts multiview from the player with the playing channel first', async () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  const source = await webSource();
  await playLive({ playlist: source, channel: source.channels[0], key: 'a' });
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  render(<LivePlayer session={session} />);
  act(() => screen.getByLabelText('Start multiview').click());
  expect(screen.getByText('Playing')).toBeTruthy();
  const watch = screen.getByRole<HTMLButtonElement>('button', { name: 'Watch multiview' });
  expect(watch.disabled).toBe(true);
  act(() => screen.getByLabelText('Add From base to multiview').click());
  await act(async () => watch.click());
  const next = useLibraryStore.getState().playerSession as LivePlayerSession;
  expect([next.title, next.multiview?.title]).toEqual(['ABC', 'From base']);
});

it('paints web panes and the empty fourth cell solid so the desktop never shows through', async () => {
  const source = await webSource();
  await playLive({ playlist: source, channel: source.channels[0], key: 'a' }, undefined, undefined, [
    { match: { playlist: source, channel: source.channels[1], key: 'b' } },
    { match: { playlist: source, channel: source.channels[2], key: 'c' } },
  ]);
  const session = useLibraryStore.getState().playerSession as LivePlayerSession;
  render(<LivePlayer session={session} />);
  const grid = screen.getByLabelText('Live TV multiview').firstElementChild!;
  expect([...grid.children].map((cell) => cell.className.includes('bg-black'))).toEqual([true, true, true, true]);
});
