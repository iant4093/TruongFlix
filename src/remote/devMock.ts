/**
 * Dev-only stand-in for the media server's `/api`, so the browser app (and its "Playing on PC"
 * remote) can be previewed with `npm run dev` at http://localhost:1420/remote.html?mock.
 */
import type { RemoteDownload, RemoteItem, RemoteLibrary, RemoteLive, RemoteNowPlaying, RemoteProfile, RemoteQualities, RemoteTitle } from './types';
import type { Quality } from '../lib/quality';
import { mockArtUrl, mockMusicRoute } from '../music/mock';

const MOCK_BYTES = 40 * 1024 * 1024;
let polls = 0;

const profiles: RemoteProfile[] = [
  { id: 1, name: 'Ian', color: '#E50914', maturity: 'all', locked: false },
  { id: 2, name: 'Kids', color: '#F5B70A', maturity: 'kids', locked: false },
];

const IMG = 'https://image.tmdb.org/t/p';
/** Preview titles with real TMDB art, so the browser app's screens look like they will. */
const art: Record<string, [string, string, string]> = {
  'The Matrix': ['tlm8UkiQsitc8rSuIAscQDCnP8d.jpg', 'dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg', 'xslT5YyQOaqcVKAZxcoq2YbcbEf.png'],
  'Dune: Part Two': ['eZ239CUp1d6OryZEBPnO2n87gMG.jpg', '6izwz7rsy95ARzTR3poZ8H6c5pp.jpg', 'ofo16Av8ssvqmGauI2kZsdiBbm2.png'],
  Dune: ['jYEW5xZkZk2WTrdbMGAPFuBqbDc.jpg', 'd5NXSklXo0qyIYkgV94XAgMIckC.jpg', 'ofo16Av8ssvqmGauI2kZsdiBbm2.png'],
  Oppenheimer: ['neeNHeXjMF5fXoCJRsOmkNGC7q.jpg', '8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', 'zl0j2MSHkAzBI773TBrycw5q20D.png'],
  Interstellar: ['8sNiAPPYU14PUepFNeSNGUTiHW.jpg', 'yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg', 'yLPDadMcGXjlNZHzW4RMYAuackd.png'],
  'Blade Runner 2049': ['gNdLJU9TxrpGx4dkZidjys3fyy0.jpg', 'gajva2L0rPYkEWjzgFlBXCAVBE5.jpg', 'yAL84wOHAMRBbNI6YfHoV52yeyP.png'],
  Inception: ['8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg', 'xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg', 'pVcoUkWWUwSXcJIEAeqlRa2q9KS.png'],
};

const item = (n: number, kind: 'movie' | 'tv', title: string, extra: Partial<RemoteItem> = {}): RemoteItem => {
  const a = art[title];
  return {
    key: `${kind}-${n}`,
    kind,
    title,
    year: 2010 + n,
    overview: `${title}: a preview title for the browser app, with enough of an overview to wrap onto a few lines like a real one does.`,
    poster: a ? `${IMG}/w500/${a[1]}` : null,
    backdrop: a ? `${IMG}/w1280/${a[0]}` : null,
    logo: a ? `${IMG}/w500/${a[2]}` : null,
    certification: 'PG-13',
    imdbRating: 8.1,
    rtScore: 92,
    metacritic: 81,
    runtime: 152,
    seasonCount: kind === 'tv' ? 2 : 0,
    genres: ['Science Fiction', 'Adventure'],
    tagline: 'Long live the fighters.',
    myList: n % 2 === 0,
    badges: ['4K', 'Dolby Vision', 'Atmos', '5.1'],
    ...extra,
  };
};

const items = [
  item(1, 'movie', 'Dune: Part Two', { progress: 0.42, hint: '1h 15m left' }),
  item(2, 'tv', 'Harbor Lights', { status: 'Returning Series', nextAir: 'S3:E2 · Mar 4', badges: ['1080p', '5.1'] }),
  item(3, 'movie', 'The Matrix'),
  item(4, 'movie', 'Oppenheimer'),
  item(5, 'movie', 'Interstellar'),
  item(6, 'movie', 'Blade Runner 2049'),
  item(7, 'movie', 'Inception'),
  item(8, 'movie', 'Dune'),
];

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
    const lib: RemoteLibrary = {
      featured: items[0],
      rows: [
        { title: 'Continue Watching', items: [items[0], { ...items[1], progress: 0.3, hint: 'S1:E3 · 22 min left' }] },
        { title: 'Recently Added', items },
        { title: 'My List', items: items.filter((i) => i.myList) },
        { title: 'Science Fiction', items: [...items].reverse() },
      ],
      all: items,
    };
    return [200, lib];
  }
  if (path === '/title') {
    const key = String((body as { item?: string }).item ?? '');
    const it = items.find((i) => i.key === key) ?? items[1];
    const tv = it.kind === 'tv';
    const t: RemoteTitle = {
      item: it,
      cast: ['A. Actor', 'B. Actor'],
      play: tv ? { type: 'episode', id: 1, label: 'S1:E1 · Pilot', resume: 0 } : { type: 'movie', id: 1, label: it.title, resume: it.progress ? 4000 : 0 },
      episodes: tv
        ? [1, 2].flatMap((season) => [1, 2, 3, 4].map((e) => ({ id: season * 10 + e, season, episode: e, title: `Episode ${e}`, overview: 'Something happens at the harbour that nobody saw coming, and the town has to decide what to do about it.', still: `${IMG}/w300/${art.Interstellar[0]}`, runtime: 45, progress: season === 1 && e === 1 ? 1 : season === 1 && e === 2 ? 0.4 : 0, watched: season === 1 && e === 1 })))
        : [],
      people: ['Timothée Chalamet', 'Zendaya', 'Rebecca Ferguson', 'Josh Brolin', 'Austin Butler', 'Florence Pugh'].map((name, i) => ({ name, role: ['Paul Atreides', 'Chani', 'Jessica', 'Gurney Halleck', 'Feyd-Rautha', 'Irulan'][i], photo: null })),
      crew: [{ name: 'Denis Villeneuve', role: tv ? 'Creator' : 'Director', photo: null }],
      seasonRatings: tv ? { 1: 8.4, 2: 8.9 } : {},
      similar: items.filter((i) => i.key !== it.key).slice(0, 6),
      collection: it.title.startsWith('Dune') ? { name: 'Dune Collection', items: [items[7], items[0]] } : null,
    };
    return [200, t];
  }
  if (method === 'POST' && path === '/mylist') {
    const it = items.find((i) => i.kind === body.kind && Number(i.key.split('-')[1]) === Number(body.id));
    if (it) it.myList = !!body.value;
    return [200, { ok: true }];
  }
  if (path === '/live') {
    const web = { playlistId: 'w', id: 'abc', name: 'ABC', group: 'Sports', source: 'My web TV', kind: 'web' as const, web: 'https://example.com/embed/abc' };
    const m3u = { playlistId: 'm', id: 'espn', name: 'ESPN', group: 'Sports', source: 'My M3U', kind: 'm3u' as const, web: null };
    const team = (name: string, abbreviation: string, score: string, color: string, rank?: number) => ({ name, abbreviation, score, color, logo: '', rank });
    const live: RemoteLive = {
      partial: false,
      leagues: [['football/nfl', 'NFL'], ['football/college-football', 'College football'], ['basketball/nba', 'NBA'], ['baseball/mlb', 'MLB'], ['hockey/nhl', 'NHL'], ['soccer/eng.1', 'Premier League']],
      channels: [web, m3u],
      events: [
        { id: '1', name: 'Texas Tech Red Raiders at Oklahoma State Cowboys', league: 'football/college-football', leagueLabel: 'College football', date: new Date().toISOString(), status: 'live', detail: 'Halftime', broadcasts: ['ESPN'], teams: [team('Oklahoma State', 'OKST', '20', '#ff7300', 25), team('Texas Tech', 'TTU', '28', '#cc0000', 12)], channels: [m3u, web] },
        { id: '2', name: '49ers at Rams', league: 'football/nfl', leagueLabel: 'NFL', date: new Date(Date.now() + 3 * 3600_000).toISOString(), status: 'upcoming', detail: '', broadcasts: ['FOX'], teams: [team('Rams', 'LAR', '', '#003594'), team('49ers', 'SF', '', '#aa0000')], channels: [] },
      ],
    };
    return [200, live];
  }
  if (path === '/remote/state') {
    advance();
    return [200, np];
  }
  if (method === 'POST' && path === '/remote/command') {
    const status = command(String(body.action), body.value);
    return status === 200 ? [200, { ok: true }] : [status, { error: 'Nothing is playing' }];
  }
  if (path === '/qualities') {
    const sizes = (kbps: number) => Math.round(((kbps + 192) * 1000 * 2700) / 8);
    const q: RemoteQualities = {
      default: { res: '1080', level: 'high' },
      options: [
        { res: 'original', label: 'Original', asIs: false, sizes: { high: sizes(10000) } },
        { res: '1080', label: '1080p', sizes: { low: sizes(4000), medium: sizes(6000), high: sizes(10000) } },
        { res: '720', label: '720p', sizes: { low: sizes(2000), medium: sizes(3000), high: sizes(5000) } },
        { res: '480', label: '480p', sizes: { low: sizes(800), medium: sizes(1200), high: sizes(2000) } },
      ],
    };
    return [200, q];
  }
  if (method === 'POST' && path === '/download') {
    polls = 0;
    const quality = (body.quality as Quality | undefined) ?? { res: '1080', level: 'high' };
    const d: RemoteDownload = {
      token: 'mock',
      url: '/stream/mock/download.mp4',
      mode: 'convert',
      mime: 'video/mp4',
      quality,
      itemKey: 'tv-2',
      title: 'Harbor Lights',
      subtitle: `S1:E${body.id} · Episode ${body.id}`,
      duration: 2700,
      estimate: MOCK_BYTES,
      chapters: [],
      segments: [],
      stinger: null,
    };
    return [200, d];
  }
  if (path === '/download/status') {
    polls++;
    return [200, { state: polls > 4 ? 'ready' : 'converting', progress: Math.min(1, polls / 5), error: null }];
  }
  if (method === 'POST' && path === '/offline/start') return [200, { token: 'mock-offline' }];
  if (method === 'POST' && (path === '/stop' || path === '/progress')) return [200, { ok: true, blocked: null }];
  if (method === 'POST' && path === '/remote/play') {
    if (body.profile !== 1) return [403, { error: 'Living Room PC is using Ian’s profile. Switch to Kids on the PC to play there.' }];
    start('Harbor Lights', 'S1:E1 · Pilot');
    return [200, { ok: true }];
  }
  return [404, { error: 'Not available in the preview' }];
}

export function installRemoteMock() {
  (window as { __TF_MUSIC_ART__?: typeof mockArtUrl }).__TF_MUSIC_ART__ = mockArtUrl;
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname.startsWith('/stream/mock/')) {
      // A made-up "download", served slowly in ranges like the PC does.
      const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '');
      const start = Number(range?.[1] ?? 0);
      const end = Math.min(Number(range?.[2] ?? MOCK_BYTES - 1), MOCK_BYTES - 1);
      await new Promise((r) => setTimeout(r, 300));
      return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${MOCK_BYTES}` } });
    }
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    const body = { ...Object.fromEntries(url.searchParams), ...(init?.body ? JSON.parse(String(init.body)) : {}) };
    const path = url.pathname.slice(4);
    const [status, data] = path.startsWith('/music/') ? mockMusicRoute(init?.method ?? 'GET', path, url.searchParams, body) : answer(init?.method ?? 'GET', path, body);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
