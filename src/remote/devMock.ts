/**
 * Dev-only stand-in for the media server's `/api`, so the browser app (and its "Playing on PC"
 * remote) can be previewed with `npm run dev` at http://localhost:1420/remote.html?mock.
 */
import type { RemoteItem, RemoteLibrary, RemoteNowPlaying, RemoteProfile, RemoteTitle } from './types';

const profiles: RemoteProfile[] = [
  { id: 1, name: 'Ian', color: '#E50914', maturity: 'all', locked: false },
  { id: 2, name: 'Kids', color: '#F5B70A', maturity: 'kids', locked: false },
];

const item = (n: number, kind: 'movie' | 'tv', title: string): RemoteItem => ({
  key: `${kind}-${n}`,
  kind,
  title,
  year: 2020 + n,
  overview: `${title} — a preview title for the browser app.`,
  poster: null,
  backdrop: null,
  logo: null,
  certification: 'PG',
  imdbRating: 7.5,
  runtime: 112,
  seasonCount: kind === 'tv' ? 2 : 0,
  genres: ['Drama'],
});

const items = [item(1, 'movie', 'The Long Weekend'), item(2, 'tv', 'Harbor Lights'), item(3, 'movie', 'Night Shift')];

const audio = [
  { id: 1, label: 'English', detail: '5.1', selected: true },
  { id: 2, label: 'French', detail: 'Stereo', selected: false },
];
const subs = [
  { id: 3, label: 'English', detail: 'SDH', selected: false },
  { id: 4, label: 'Spanish', detail: null, selected: false },
];

let np: RemoteNowPlaying = { active: false, pc: 'Living Room PC' };
let lastTick = Date.now();

function start(title: string, subtitle: string | null) {
  np = {
    active: true,
    pc: 'Living Room PC',
    source: 'player',
    type: subtitle ? 'episode' : 'movie',
    id: 1,
    title,
    subtitle,
    art: null,
    poster: null,
    logo: null,
    time: 0,
    duration: 2700,
    paused: false,
    buffering: false,
    volume: 70,
    muted: false,
    fullscreen: false,
    audioTracks: audio.map((a) => ({ ...a })),
    subTracks: subs.map((s) => ({ ...s })),
    next: subtitle ? 'S1:E2 · The Pier' : null,
    prompt: null,
    can: { seek: true, skip: true, volume: true, tracks: true, next: !!subtitle, fullscreen: true },
  };
  lastTick = Date.now();
}
start('Harbor Lights', 'S1:E1 · Pilot');

function advance() {
  const now = Date.now();
  if (np.active && !np.paused) np.time = Math.min(np.duration ?? 0, (np.time ?? 0) + (now - lastTick) / 1000);
  lastTick = now;
}

function command(action: string, value: unknown) {
  advance();
  if (!np.active) return 404;
  const v = Number(value);
  if (action === 'toggle') np.paused = !np.paused;
  else if (action === 'play' || action === 'pause') np.paused = action === 'pause';
  else if (action === 'seek') np.time = v;
  else if (action === 'skip') np.time = Math.max(0, (np.time ?? 0) + v);
  else if (action === 'volume') np = { ...np, volume: v, muted: v > 0 ? false : np.muted };
  else if (action === 'mute') np.muted = !!value;
  else if (action === 'audio') np.audioTracks = np.audioTracks!.map((a) => ({ ...a, selected: a.id === v }));
  else if (action === 'subtitle') np.subTracks = np.subTracks!.map((s) => ({ ...s, selected: s.id === v }));
  else if (action === 'fullscreen') np.fullscreen = !np.fullscreen;
  else if (action === 'next') start('Harbor Lights', np.next ?? 'S1:E2');
  else if (action === 'stop') np = { active: false, pc: np.pc };
  return 200;
}

function answer(method: string, path: string, body: Record<string, unknown>): [number, unknown] {
  if (path === '/login') return [200, { token: 'dev' }];
  if (path === '/profiles') return [200, profiles];
  if (path === '/library') {
    const lib: RemoteLibrary = { featured: null, rows: [{ title: 'Recently Added', items }], all: items };
    return [200, lib];
  }
  if (path === '/title') {
    const t: RemoteTitle = {
      item: items[1],
      cast: ['A. Actor', 'B. Actor'],
      play: { type: 'episode', id: 1, label: 'S1:E1 · Pilot', resume: 0 },
      episodes: [1, 2, 3].map((e) => ({ id: e, season: 1, episode: e, title: `Episode ${e}`, overview: null, still: null, runtime: 45, progress: 0, watched: false })),
    };
    return [200, t];
  }
  if (path === '/remote/state') {
    advance();
    return [200, np];
  }
  if (method === 'POST' && path === '/remote/command') {
    const status = command(String(body.action), body.value);
    return status === 200 ? [200, { ok: true }] : [status, { error: 'Nothing is playing' }];
  }
  if (method === 'POST' && path === '/remote/play') {
    if (body.profile !== 1) return [403, { error: 'Living Room PC is using Ian’s profile. Switch to Kids on the PC to play there.' }];
    start('Harbor Lights', 'S1:E1 · Pilot');
    return [200, { ok: true }];
  }
  return [404, { error: 'Not available in the preview' }];
}

export function installRemoteMock() {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const [status, data] = answer(init?.method ?? 'GET', url.pathname.slice(4), body);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
