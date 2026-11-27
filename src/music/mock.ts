/**
 * Dev-only music library for previews (`/remote.html?mock` and the desktop app in a plain
 * browser): made-up albums with generated covers, generated audio and a few lyrics (word-timed,
 * line-timed and plain). Answers the same `/music/…` routes as `services/musicroute.ts`.
 */
import { assembleLibrary, PLAYLIST_DESCRIPTION_MAX } from './library';
import type { MusicLyrics, MusicPin, MusicPlaylist, MusicTrack } from './types';

interface AlbumSeed {
  title: string;
  artist: string;
  year: number;
  genre: string;
  colors: [string, string, string];
  shape: 'sun' | 'rings' | 'waves' | 'grid' | 'orbit' | 'peaks';
  tracks: [string, number, string?][];
}

const ALBUMS: AlbumSeed[] = [
  {
    title: 'Neon Harbour',
    artist: 'Luma Vale',
    year: 2023,
    genre: 'Synth Pop',
    colors: ['#ff4f8b', '#7b2ff7', '#1a0b3d'],
    shape: 'sun',
    tracks: [['Glass Tides', 96], ['Afterglow Avenue', 212], ['Paper Lanterns', 187], ['Velvet Signal', 241], ['Static Hearts', 199], ['Harbour Lights', 263]],
  },
  {
    title: 'Paper Satellites',
    artist: 'The Quiet Orbit',
    year: 2021,
    genre: 'Indie',
    colors: ['#38d6c4', '#2a5fd8', '#0b1d3a'],
    shape: 'orbit',
    tracks: [['Slow Return', 88], ['Copper Moon', 203], ['Weightless', 176], ['Ground Control Waltz', 228], ['Northern Wire', 194]],
  },
  {
    title: 'Golden Hour Static',
    artist: 'Marlowe & June',
    year: 2019,
    genre: 'Folk',
    colors: ['#ffb347', '#ff6a3d', '#4a1c1c'],
    shape: 'peaks',
    tracks: [['Kitchen Radio', 172], ['Dust on the Dashboard', 214], ['Small Town Comet', 189], ['Porch Light', 233]],
  },
  {
    title: 'Low Tide Letters',
    artist: 'Ana Ferreira',
    year: 2022,
    genre: 'Singer/Songwriter',
    colors: ['#9be7b4', '#2f8f83', '#0d2b2b'],
    shape: 'waves',
    tracks: [['Salt in the Envelope', 201], ['Lighthouse Keeper', 245], ['Undertow', 187], ['Postcards', 164]],
  },
  {
    title: 'Night Bus Sessions',
    artist: 'Various Artists',
    year: 2020,
    genre: 'Electronic',
    colors: ['#5f7cff', '#ff5fd2', '#0a0a24'],
    shape: 'grid',
    tracks: [['Last Stop', 222, 'Kei Moriyama'], ['Sodium Glow', 198, 'Luma Vale'], ['Window Seat', 241, 'Odessa Rain'], ['3 A.M. Transfer', 207, 'The Quiet Orbit']],
  },
  {
    title: 'Echo Valley',
    artist: 'Luma Vale',
    year: 2018,
    genre: 'Synth Pop',
    colors: ['#c7a6ff', '#ff8fb1', '#2b1340'],
    shape: 'rings',
    tracks: [['First Light', 205], ['Echo Valley', 236], ['Polaroid Summer', 191]],
  },
];

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function coverSvg(seed: AlbumSeed, i: number): string {
  const [a, b, c] = seed.colors;
  seed = { ...seed, title: xml(seed.title), artist: xml(seed.artist) };
  const shapes: Record<AlbumSeed['shape'], string> = {
    sun: `<circle cx="300" cy="250" r="140" fill="url(#g1)"/><g fill="${c}" opacity=".85">${[0, 1, 2, 3, 4].map((k) => `<rect x="0" y="${270 + k * 34}" width="600" height="${10 + k * 3}"/>`).join('')}</g>`,
    rings: [1, 2, 3, 4, 5].map((k) => `<circle cx="300" cy="300" r="${k * 46}" fill="none" stroke="${k % 2 ? a : b}" stroke-width="18" opacity="${1 - k * 0.13}"/>`).join(''),
    waves: [0, 1, 2, 3, 4, 5].map((k) => `<path d="M0 ${200 + k * 60} Q150 ${150 + k * 60} 300 ${200 + k * 60} T600 ${200 + k * 60} V600 H0Z" fill="${k % 2 ? a : b}" opacity="${0.35 + k * 0.1}"/>`).join(''),
    grid: Array.from({ length: 36 }, (_, k) => `<rect x="${60 + (k % 6) * 82}" y="${60 + Math.floor(k / 6) * 82}" width="62" height="62" rx="10" fill="${(k * 7) % 3 ? a : b}" opacity="${0.25 + ((k * 13) % 10) / 14}"/>`).join(''),
    orbit: `<circle cx="300" cy="300" r="90" fill="url(#g1)"/><ellipse cx="300" cy="300" rx="230" ry="80" fill="none" stroke="${a}" stroke-width="10" transform="rotate(-24 300 300)"/><circle cx="505" cy="215" r="22" fill="${b}"/>`,
    peaks: `<circle cx="420" cy="190" r="80" fill="${a}"/><path d="M0 520 L170 260 L300 430 L420 300 L600 520 V600 H0Z" fill="${b}"/><path d="M0 600 L220 380 L380 520 L600 400 V600Z" fill="${c}" opacity=".9"/>`,
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><linearGradient id="g0" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient><radialGradient id="g1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".35" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient></defs><rect width="600" height="600" fill="url(#g0)"/>${shapes[seed.shape]}<text x="40" y="560" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="#fff" opacity=".85">${seed.title.toUpperCase()}</text><text x="40" y="70" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#fff" opacity=".7">${seed.artist} · ${i + 1}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Word-timed (enhanced LRC) lyrics with an intro break. */
const GLASS_TIDES = `[ar:Luma Vale]
[ti:Glass Tides]
[00:08.00]<00:08.00>Under <00:08.60>the <00:08.90>neon, <00:09.80>the <00:10.10>water <00:10.90>is <00:11.20>bright<00:12.40>
[00:12.80]<00:12.80>Every <00:13.40>wave <00:14.00>is <00:14.30>a <00:14.50>window <00:15.40>tonight<00:16.60>
[00:17.00]<00:17.00>Hold <00:17.50>the <00:17.80>line, <00:18.60>hold <00:19.10>the <00:19.40>light<00:20.80>
[00:21.20]<00:21.20>We <00:21.50>were <00:21.80>made <00:22.30>of <00:22.60>glass <00:23.40>and <00:23.70>tide<00:25.00>
[00:33.00]<00:33.00>Oh, <00:33.70>the <00:34.00>harbour <00:35.00>keeps <00:35.50>our <00:35.80>names<00:37.20>
[00:37.50]<00:37.50>Written <00:38.20>soft <00:38.80>in <00:39.10>silver <00:40.00>flames<00:41.40>
[00:41.80]<00:41.80>Turn <00:42.30>the <00:42.60>radio <00:43.60>low<00:44.60>
[00:45.00]<00:45.00>Let <00:45.40>the <00:45.70>city <00:46.50>glow<00:48.00>
[00:49.00]<00:49.00>Glass <00:49.80>tides, <00:50.60>glass <00:51.40>tides<00:52.80>
[00:53.20]<00:53.20>Carry <00:54.00>me <00:54.40>home <00:55.20>tonight<00:57.00>
[01:05.00]<01:05.00>Under <01:05.60>the <01:05.90>neon, <01:06.80>we <01:07.10>stay <01:07.70>awake<01:09.00>
[01:09.40]<01:09.40>Counting <01:10.20>the <01:10.50>lights <01:11.20>on <01:11.50>the <01:11.80>lake<01:13.20>
[01:13.60]<01:13.60>Glass <01:14.40>tides, <01:15.20>glass <01:16.00>tides<01:17.40>
[01:17.80]<01:17.80>Carry <01:18.60>me <01:19.00>home<01:21.00>
[01:22.00]`;

const SLOW_RETURN = `[00:06.50]Static on the line, a voice I used to know
[00:11.20]Counting down the miles in a slow return
[00:16.00]Every little signal says it's time to go
[00:20.40]Paper satellites, watch them turn
[00:25.00]
[00:36.00]We could drift forever in the quiet blue
[00:40.50]Orbiting the things we never said
[00:45.00]Every little signal brings me back to you
[00:49.50]Paper satellites over my head
[00:54.00]Over my head
[01:00.00]`;

const SALT = `Salt in the envelope, sand in the seam
I wrote you a letter in the shape of a dream

Mailed it at low tide, the gulls took it far
Somewhere past the breakwater, under a star

And if it comes back to me, I'll know what it means
Salt in the envelope, sand in the seam`;

interface MockPlay {
  profile: number;
  trackId: number;
  playedAt: number;
  seconds: number | null;
}

interface MockState {
  tracks: MusicTrack[];
  lyrics: Map<number, MusicLyrics>;
  playlists: MusicPlaylist[];
  pins: MusicPin[];
  covers: Map<string, string>;
  plays: MockPlay[];
}

let state: MockState | null = null;

function build(): MockState {
  const tracks: MusicTrack[] = [];
  const covers = new Map<string, string>();
  const artistIds = new Map<string, number>();
  const artistId = (name: string) => {
    if (!artistIds.has(name)) artistIds.set(name, artistIds.size + 1);
    return artistIds.get(name)!;
  };
  const now = Date.now();
  let id = 0;
  ALBUMS.forEach((album, ai) => {
    const art = `mock-cover-${ai}`;
    covers.set(art, coverSvg(album, ai));
    album.tracks.forEach(([title, duration, artist], ti) => {
      id++;
      const trackArtist = artist ?? album.artist;
      tracks.push({
        id,
        title,
        artist: trackArtist,
        artistId: artistId(trackArtist),
        album: album.title,
        albumId: ai + 1,
        albumArtist: album.artist,
        albumArtistId: artistId(album.artist),
        trackNo: ti + 1,
        discNo: 1,
        year: album.year,
        genre: album.genre,
        duration,
        codec: ai === 1 ? 'flac' : ai === 3 ? 'alac' : 'aac',
        sampleRate: ai === 3 ? 96000 : 44100,
        bitDepth: ai === 1 ? 16 : ai === 3 ? 24 : null,
        bitrate: ai === 1 ? 980 : ai === 3 ? 3100 : 256,
        art,
        favourite: id % 4 === 1,
        plays: ai === 0 ? 12 - ti : ai === 2 ? 6 - ti : ai === 1 ? 3 : 0,
        lastPlayed: ai === 0 ? now - 3600_000 * (ti + 1) : ai === 2 ? now - 86400_000 * 2 : ai === 1 ? now - 86400_000 : null,
        addedAt: now - 86400_000 * (ALBUMS.length - ai) * 3,
        hasLyrics: id === 1 || id === 7 || title === 'Salt in the Envelope',
      });
    });
  });
  const lyrics = new Map<number, MusicLyrics>();
  lyrics.set(1, { text: GLASS_TIDES, synced: true, source: 'sidecar' });
  lyrics.set(7, { text: SLOW_RETURN, synced: true, source: 'lrclib' });
  const salt = tracks.find((t) => t.title === 'Salt in the Envelope');
  if (salt) lyrics.set(salt.id, { text: SALT, synced: false, source: 'embedded' });
  const playlists: MusicPlaylist[] = [
    { id: 1, name: 'Late Night Drive', trackIds: [2, 8, 20, 22, 5, 23], updatedAt: now - 3600_000 },
    { id: 2, name: 'Sunday Morning', trackIds: [12, 13, 17, 18, 15], updatedAt: now - 86400_000 },
  ];
  return { tracks, lyrics, playlists, pins: [], covers, plays: seedPlays(tracks) };
}

/** This year's listening for profile 1 ("Ian"), so Wrapped has a Music section. */
function seedPlays(tracks: MusicTrack[]): MockPlay[] {
  const plays: MockPlay[] = [];
  const now = new Date();
  let seed = 5;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Neon Harbour (and Luma Vale) most, then the rest.
  const weight = (t: MusicTrack) => (t.albumId === 1 ? 6 : t.artist === 'Luma Vale' ? 3 : t.albumId === 3 ? 2.5 : 1) / (t.trackNo ?? 1) ** 0.3;
  const total = tracks.reduce((n, t) => n + weight(t), 0);
  const pick = () => {
    let r = rand() * total;
    for (const t of tracks) if ((r -= weight(t)) <= 0) return t;
    return tracks[0];
  };
  const add = (day: Date, hour: number, t: MusicTrack) => {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, Math.floor(rand() * 60)).getTime();
    if (at > now.getTime() || new Date(at).getFullYear() !== now.getFullYear()) return;
    // Most plays have a recorded time; some were cut short, some predate it (counted as the song's length).
    const r = rand();
    plays.push({ profile: 1, trackId: t.id, playedAt: at, seconds: r < 0.15 ? null : r < 0.35 ? Math.round(t.duration * (0.4 + rand() * 0.5)) : t.duration });
  };
  for (let d = 0; d < 320; d += 1 + Math.floor(rand() * 3)) {
    const day = new Date(now.getTime() - d * 864e5);
    const hour = rand() < 0.5 ? 22 + Math.floor(rand() * 2) : rand() < 0.6 ? 18 + Math.floor(rand() * 3) : 8 + Math.floor(rand() * 4);
    for (let n = 2 + Math.floor(rand() * 8); n > 0; n--) add(day, hour, pick());
  }
  // Ten days in a row, and one day with Glass Tides on repeat.
  for (let d = 1; d <= 10; d++) for (let n = 0; n < 4; n++) add(new Date(now.getTime() - d * 864e5), 21, pick());
  for (let n = 0; n < 7; n++) add(new Date(now.getTime() - 25 * 864e5), 23, tracks[0]);
  return plays.sort((a, b) => a.playedAt - b.playedAt);
}

/** Rows for musicdb's `listMusicPlays` query, answered by the desktop preview's SQL mock. */
export function mockMusicPlayRows(profileId: number) {
  const s = mock();
  const byId = new Map(s.tracks.map((t) => [t.id, t]));
  return s.plays
    .filter((p) => p.profile === profileId && byId.has(p.trackId))
    .map((p) => {
      const t = byId.get(p.trackId)!;
      return {
        track_id: t.id, title: t.title, artist: t.artist, artist_id: t.artistId, album: t.album, album_id: t.albumId, album_artist: t.albumArtist,
        genre: t.genre, art: t.art, duration: t.duration, played_at: p.playedAt, seconds: p.seconds,
      };
    });
}

const mock = () => (state ??= build());

const audioUrls = new Map<number, string>();

/** A soft chord progression as long as the song, so the scrubber and lyrics move for real. */
function toneFor(track: MusicTrack): string {
  const hit = audioUrls.get(track.id);
  if (hit) return hit;
  const rate = 8000;
  const n = Math.round(track.duration * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  const chords = [
    [220, 277.18, 329.63],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [196, 246.94, 329.63],
  ].map((c) => c.map((f) => f * (1 + (track.id % 5) * 0.06)));
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const chord = chords[Math.floor(t / 2) % chords.length];
    const beat = t % 2;
    const env = Math.min(1, beat * 8) * Math.exp(-beat * 1.2);
    let s = 0;
    for (const f of chord) s += Math.sin(2 * Math.PI * f * t);
    v.setInt16(44 + i * 2, Math.round(s * env * 1800), true);
  }
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  audioUrls.set(track.id, url);
  return url;
}

export const mockArtUrl = (art: string | null | undefined) => (art ? mock().covers.get(art) ?? null : null);

/** Answers a `/music/…` request like the PC would. */
export function mockMusicRoute(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): [number, unknown] {
  const s = mock();
  const id = Number(body.id ?? query.get('id'));
  if (method === 'GET' && path === '/music/library') return [200, assembleLibrary(s.tracks, s.playlists, s.pins)];
  if (method === 'GET' && path === '/music/lyrics') return [200, s.lyrics.get(id) ?? null];
  if (method === 'POST' && path === '/music/stream') {
    const t = s.tracks.find((x) => x.id === id);
    return t ? [200, { url: toneFor(t), transcoded: false }] : [404, { error: 'Not found' }];
  }
  if (method === 'POST' && path === '/music/played') {
    const t = s.tracks.find((x) => x.id === id);
    if (t) Object.assign(t, { plays: t.plays + 1, lastPlayed: Date.now() });
    if (t) s.plays.push({ profile: 1, trackId: t.id, playedAt: Date.now(), seconds: null });
    return [200, { ok: true }];
  }
  if (method === 'POST' && path === '/music/listened') {
    const play = [...s.plays].reverse().find((p) => p.trackId === id && p.seconds == null);
    const t = s.tracks.find((x) => x.id === id);
    if (play && t) play.seconds = Math.min(Number(body.seconds) || 0, t.duration);
    return [200, { ok: true }];
  }
  if (method === 'POST' && path === '/music/favourite') {
    const t = s.tracks.find((x) => x.id === id);
    if (t) t.favourite = !!body.value;
    return [200, { ok: true }];
  }
  if (method === 'POST' && path === '/music/pin') {
    const kind = body.kind === 'album' || body.kind === 'playlist' ? body.kind : null;
    if (!kind) return [400, { error: 'Bad request' }];
    const others = s.pins.filter((p) => !(p.kind === kind && p.id === id));
    if (!body.value) s.pins = others;
    else if (!(kind === 'album' ? s.tracks.some((t) => t.albumId === id) : s.playlists.some((p) => p.id === id))) return [404, { error: 'Not found' }];
    else if (others.length === s.pins.length) s.pins = [...s.pins, { kind, id }];
    return [200, { ok: true }];
  }
  if (method === 'POST' && path === '/music/playlists/create') {
    const p: MusicPlaylist = { id: Math.max(0, ...s.playlists.map((x) => x.id)) + 1, name: String(body.name ?? 'New Playlist'), trackIds: (body.trackIds as number[]) ?? [], updatedAt: Date.now() };
    s.playlists.unshift(p);
    return [200, p];
  }
  const pl = s.playlists.find((p) => p.id === id);
  if (path.startsWith('/music/playlists/') && !pl) return [404, { error: 'Not found' }];
  if (pl && path === '/music/playlists/rename') Object.assign(pl, { name: String(body.name), updatedAt: Date.now() });
  else if (pl && path === '/music/playlists/delete') {
    s.playlists = s.playlists.filter((p) => p !== pl);
    s.pins = s.pins.filter((p) => !(p.kind === 'playlist' && p.id === pl.id));
  }
  else if (pl && path === '/music/playlists/tracks') Object.assign(pl, { trackIds: body.trackIds as number[], updatedAt: Date.now() });
  else if (pl && path === '/music/playlists/add') Object.assign(pl, { trackIds: [...pl.trackIds, ...(body.trackIds as number[])], updatedAt: Date.now() });
  else if (pl && path === '/music/playlists/description') {
    Object.assign(pl, { description: String(body.description ?? '').replace(/\s+/g, ' ').trim().slice(0, PLAYLIST_DESCRIPTION_MAX), updatedAt: Date.now() });
    return [200, { description: pl.description }];
  } else if (pl && path === '/music/playlists/cover') {
    let cover: string | null = null;
    if (typeof body.image === 'string') {
      cover = `mock-cover-${pl.id}-${Date.now()}`;
      s.covers.set(cover, `data:image/jpeg;base64,${body.image}`);
    }
    Object.assign(pl, { cover, customCover: !!cover, updatedAt: Date.now() });
    return [200, { cover, customCover: !!cover }];
  } else return [404, { error: 'Not available in the preview' }];
  return [200, { ok: true }];
}
