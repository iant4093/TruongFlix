/**
 * Dev-only browser preview: fakes the Tauri IPC layer (SQLite, VLC, scanner) with fixture
 * data so the UI can be developed in a regular browser via `npm run dev`.
 * Never included in production builds (guarded by import.meta.env.DEV in main.tsx).
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type { EpisodeRow, MovieRow, SeriesRow, SubtitleRow, TrashRow } from '../types/media';

const IMG = 'https://image.tmdb.org/t/p';
const now = new Date();
const ts = (daysAgo: number) => new Date(now.getTime() - daysAgo * 864e5).toISOString().replace('T', ' ').slice(0, 19);

const tech = (resolution: string | null, hdr: string | null, codec: string | null, audio: string | null) => ({
  resolution,
  hdr_format: hdr,
  video_codec: codec,
  audio_codec: audio,
});

let nextId = 1;
function movie(
  title: string,
  tmdb: number,
  year: number,
  art: [string, string, string],
  extra: Partial<MovieRow>,
): MovieRow {
  return {
    id: nextId++,
    tmdb_id: tmdb,
    file_path: `/Volumes/Media/Movies/${title.replace(/\W+/g, '.')}.${year}.2160p.mkv`,
    raw_filename: `${title.replace(/\W+/g, '.')}.${year}.2160p.mkv`,
    file_mtime: 0,
    title,
    original_title: title,
    year,
    overview: '',
    tagline: null,
    runtime: 120,
    vote_average: 8,
    genres: '[]',
    cast_crew: '[]',
    poster_path: `${IMG}/w500/${art[1]}`,
    backdrop_path: `${IMG}/original/${art[0]}`,
    logo_path: `${IMG}/w500/${art[2]}`,
    ...tech('4K', null, 'HEVC', null),
    imdb_id: null,
    imdb_rating: null,
    imdb_votes: null,
    progress_seconds: 0,
    duration_seconds: 0,
    watched: 0,
    my_list: 0,
    last_watched_at: null,
    created_at: ts(1),
    ...extra,
  };
}

const cast = (...names: string[]) => JSON.stringify([...names.map((n) => ({ name: n })), { name: 'Christopher Nolan', job: 'Director' }]);

const movies: MovieRow[] = [
  movie('The Matrix', 603, 1999, ['tlm8UkiQsitc8rSuIAscQDCnP8d.jpg', 'dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg', 'xslT5YyQOaqcVKAZxcoq2YbcbEf.png'], {
    imdb_id: 'tt0133093',
    imdb_rating: 8.7,
    imdb_votes: 2289735,
    overview:
      'Set in the 22nd century, The Matrix tells the story of a computer hacker who joins a group of underground insurgents fighting the vast and powerful computers who now rule the earth.',
    tagline: 'Welcome to the Real World.',
    runtime: 136,
    vote_average: 8.2,
    genres: '["Action","Science Fiction"]',
    cast_crew: cast('Keanu Reeves', 'Laurence Fishburne', 'Carrie-Anne Moss', 'Hugo Weaving', 'Joe Pantoliano'),
    ...tech('4K', 'Dolby Vision', 'HEVC', 'Lossless Audio, 5.1'),
    progress_seconds: 3100,
    duration_seconds: 8160,
    last_watched_at: ts(0.2),
    created_at: ts(3),
  }),
  movie('Dune: Part Two', 693134, 2024, ['eZ239CUp1d6OryZEBPnO2n87gMG.jpg', '6izwz7rsy95ARzTR3poZ8H6c5pp.jpg', 'ofo16Av8ssvqmGauI2kZsdiBbm2.png'], {
    imdb_id: 'tt15239678',
    imdb_rating: 8.5,
    imdb_votes: 690000,
    overview:
      'Follow the mythic journey of Paul Atreides as he unites with Chani and the Fremen while on a path of revenge against the conspirators who destroyed his family.',
    runtime: 167,
    vote_average: 8.1,
    genres: '["Science Fiction","Adventure"]',
    cast_crew: cast('Timothée Chalamet', 'Zendaya', 'Rebecca Ferguson', 'Javier Bardem'),
    ...tech('4K', 'HDR10', 'HEVC', 'Atmos, 5.1'),
    my_list: 1,
  }),
  movie('Oppenheimer', 872585, 2023, ['neeNHeXjMF5fXoCJRsOmkNGC7q.jpg', '8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', 'zl0j2MSHkAzBI773TBrycw5q20D.png'], {
    imdb_id: 'tt15398776',
    imdb_rating: 8.3,
    imdb_votes: 920000,
    overview:
      "The story of J. Robert Oppenheimer's role in the development of the atomic bomb during World War II.",
    runtime: 181,
    vote_average: 8.1,
    genres: '["Drama","History"]',
    cast_crew: cast('Cillian Murphy', 'Emily Blunt', 'Matt Damon', 'Robert Downey Jr.'),
    ...tech('HD', null, 'H.264', 'Lossless Audio, 5.1'),
  }),
  movie('Interstellar', 157336, 2014, ['8sNiAPPYU14PUepFNeSNGUTiHW.jpg', 'yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg', 'yLPDadMcGXjlNZHzW4RMYAuackd.png'], {
    imdb_id: 'tt0816692',
    imdb_rating: 8.7,
    imdb_votes: 2400000,
    overview:
      'The adventures of a group of explorers who make use of a newly discovered wormhole to surpass the limitations on human space travel and conquer the vast distances involved in an interstellar voyage.',
    runtime: 169,
    vote_average: 8.5,
    genres: '["Adventure","Drama","Science Fiction"]',
    cast_crew: cast('Matthew McConaughey', 'Anne Hathaway', 'Jessica Chastain', 'Michael Caine'),
    ...tech('4K', 'HDR10', 'HEVC', 'Atmos'),
  }),
  movie('Blade Runner 2049', 335984, 2017, ['gNdLJU9TxrpGx4dkZidjys3fyy0.jpg', 'gajva2L0rPYkEWjzgFlBXCAVBE5.jpg', 'yAL84wOHAMRBbNI6YfHoV52yeyP.png'], {
    imdb_id: 'tt1856101',
    imdb_rating: 8.0,
    imdb_votes: 680000,
    overview:
      'Thirty years after the events of the first film, a new blade runner, LAPD Officer K, unearths a long-buried secret that has the potential to plunge what\'s left of society into chaos.',
    runtime: 164,
    vote_average: 7.6,
    genres: '["Science Fiction","Drama"]',
    cast_crew: cast('Ryan Gosling', 'Harrison Ford', 'Ana de Armas'),
  }),
  movie('Inception', 27205, 2010, ['8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg', 'xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg', 'pVcoUkWWUwSXcJIEAeqlRa2q9KS.png'], {
    imdb_id: 'tt1375666',
    imdb_rating: 8.8,
    imdb_votes: 2700000,
    overview:
      'Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious of his targets is offered a chance to regain his old life as payment for a task considered to be impossible.',
    runtime: 148,
    vote_average: 8.4,
    genres: '["Action","Science Fiction","Adventure"]',
    cast_crew: cast('Leonardo DiCaprio', 'Joseph Gordon-Levitt', 'Elliot Page', 'Tom Hardy'),
    ...tech('HD', null, 'H.264', '5.1'),
  }),
  {
    ...movie('d-dune2', 0, 0, ['', '', ''], {}),
    tmdb_id: null,
    year: null,
    title: 'xyz-mtrx-remux',
    poster_path: null,
    backdrop_path: null,
    logo_path: null,
    vote_average: null,
    file_path: '/Volumes/Media/Downloads/xyz-mtrx-remux.mkv',
    raw_filename: 'xyz-mtrx-remux.mkv',
  },
];

const series: SeriesRow[] = [
  ['Severance', 95396, 2022, 'ixgFmf1X59PUZam2qbAfskx2gQr.jpg', 'pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg', 'yyS1tALk7t3YdTNMOvR5gsnXINA.png', 8.4, '["Drama","Mystery","Sci-Fi & Fantasy"]',
    'Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives. When a mysterious colleague appears outside of work, it begins a journey to discover the truth about their jobs.'],
  ['Breaking Bad', 1396, 2008, 'tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg', 'anFx9aTOOYqgS3v7x3R84Kz67ly.jpg', 'ojzKpMUAcA91P6wF0TfCyAvvYLw.png', 8.9, '["Drama","Crime"]',
    "Walter White, a New Mexico chemistry teacher, is diagnosed with Stage III cancer and given a prognosis of only two years left to live. He becomes filled with a sense of fearlessness and an unrelenting desire to secure his family's financial future at any cost."],
  ['Stranger Things', 66732, 2016, '9P4IIMYY3HifqeruZq0ZZ9g7YUi.jpg', 'uOOtwVbSr4QDjAGIifLDwpb2Pdl.jpg', 'zvuoDjkbS9USzSWo4pD5eiyI5se.png', 8.6, '["Sci-Fi & Fantasy","Mystery","Action & Adventure"]',
    'When a young boy vanishes, a small town uncovers a mystery involving secret experiments, terrifying supernatural forces, and one strange little girl.'],
].map(([title, tmdb, year, bd, po, logo, vote, genres, overview], i) => ({
  id: 100 + i,
  tmdb_id: tmdb as number,
  folder_path: null,
  title: title as string,
  year: year as number,
  overview: overview as string,
  vote_average: vote as number,
  genres: genres as string,
  cast_crew: JSON.stringify([{ name: 'Adam Scott' }, { name: 'Britt Lower' }, { name: 'Patricia Arquette' }, { name: 'John Turturro' }, { name: 'Ben Stiller', job: 'Creator' }]),
  poster_path: `${IMG}/w500/${po}`,
  backdrop_path: `${IMG}/original/${bd}`,
  logo_path: `${IMG}/w500/${logo}`,
  number_of_seasons: 2,
  my_list: i === 0 ? 1 : 0,
  last_watched_at: i === 0 ? ts(0.1) : null,
  created_at: ts(i + 2),
  imdb_id: ['tt11280740', 'tt0903747', 'tt4574334'][i],
  imdb_rating: [8.6, 9.5, 8.6][i],
  imdb_votes: [413395, 2300000, 1400000][i],
  imdb_season_ratings: JSON.stringify([
    { 1: { rating: 8.5, count: 9 }, 2: { rating: 8.7, count: 10 } },
    { 1: { rating: 8.4, count: 7 }, 2: { rating: 8.6, count: 13 } },
    { 1: { rating: 8.7, count: 8 }, 2: { rating: 8.3, count: 9 } },
  ][i]),
}));

let epId = 1000;
const episodes: EpisodeRow[] = [];
for (const s of series) {
  for (let season = 1; season <= 2; season++)
    for (let e = 1; e <= 5; e++) {
      const watched = s.id === 100 && season === 1 && e <= 2;
      episodes.push({
        id: epId++,
        series_id: s.id,
        tmdb_episode_id: null,
        file_path: `/Volumes/Media/Shows/${s.title}/Season ${season}/S0${season}E0${e}.mkv`,
        raw_filename: `S0${season}E0${e}.mkv`,
        file_mtime: 0,
        season_number: season,
        episode_number: e,
        title: ['Good News About Hell', 'Half Loop', 'In Perpetuity', 'The You You Are', 'The Grim Barbarity'][e - 1],
        overview: 'Mark is promoted to department chief after his best friend and colleague is unexpectedly fired. Helly struggles to adjust.',
        still_path: null,
        air_date: null,
        runtime: 55,
        ...tech(season === 2 ? '4K' : 'HD', season === 2 ? 'Dolby Vision' : null, 'HEVC', 'Atmos, 5.1'),
        imdb_id: `tt9${s.id}${season}${e}`,
        imdb_rating: [8.1, 8.2, 8.0, 8.4, 9.0][e - 1],
        imdb_votes: 18000 + e * 900,
        progress_seconds: 0,
        duration_seconds: 3300,
        watched: watched ? 1 : 0,
        last_watched_at: watched ? ts(0.1 + (2 - e) * 0.01) : null,
      });
    }
}

const settings: Record<string, string> = {
  tmdb_api_key: 'dev-mock-key',
  vlc_executable_path: '/Applications/VLC.app/Contents/MacOS/VLC',
  media_directories: '["/Volumes/Media/Movies","/Volumes/Media/Shows"]',
  opensubtitles_api_key: 'dev-mock-os-key',
  subtitle_language: 'en',
  imdb_last_sync: new Date().toISOString(),
};

let subId = 1;
const subtitles: SubtitleRow[] = [];

function handleSubtitleSql(q: string, values: unknown[]): unknown {
  const [type, id] = values as [string, number];
  const forMedia = () => subtitles.filter((s) => s.media_type === type && s.media_id === id);
  if (q.startsWith('SELECT * FROM subtitles')) return [...forMedia()].reverse();
  if (q.startsWith('SELECT id FROM subtitles')) return forMedia().filter((s) => s.file_path === values[2]).map((s) => ({ id: s.id }));
  if (q.startsWith('SELECT file_path FROM subtitles')) return forMedia().filter((s) => s.selected).map((s) => ({ file_path: s.file_path }));
  if (q.startsWith('INSERT INTO subtitles')) {
    const [, , language, file_path, source, release_name, hash_match, file_id] = values as [string, number, string, string, 'opensubtitles' | 'local', string, number, number];
    const existing = forMedia().find((s) => s.file_path === file_path);
    if (existing) Object.assign(existing, { language, source, release_name, hash_match, opensubtitles_file_id: file_id });
    else
      subtitles.push({
        id: subId++, media_type: type as 'movie' | 'episode', media_id: id, language, file_path, source, release_name,
        hash_match, opensubtitles_file_id: file_id, selected: 0, created_at: ts(0),
      });
  } else if (q.startsWith('UPDATE subtitles SET selected')) {
    for (const s of forMedia()) s.selected = s.id === values[2] ? 1 : 0;
  } else if (q.startsWith('DELETE FROM subtitles WHERE id')) {
    const idx = subtitles.findIndex((s) => s.id === values[0]);
    if (idx >= 0) subtitles.splice(idx, 1);
  }
  return [1, 0];
}

const mockSubtitleResults = {
  data: [
    { attributes: { language: 'en', release: 'Show.S01E01.1080p.WEB.H264-GROUP', download_count: 18234, moviehash_match: true, from_trusted: true, files: [{ file_id: 9001 }] } },
    { attributes: { language: 'en', release: 'Show.S01E01.720p.HDTV.x264-OTHER', download_count: 4210, hearing_impaired: true, files: [{ file_id: 9002 }] } },
    { attributes: { language: 'en', release: 'Machine translated junk', download_count: 99, machine_translated: true, files: [{ file_id: 9003 }] } },
  ],
};

let trashId = 1;
const trash: TrashRow[] = [];
const tables = { movies, episodes, tv_series: series } as unknown as Record<string, { id: number }[]>;

/** Generic `INSERT OR IGNORE INTO t (a, b) VALUES ($1, $2)` used by restore. */
function genericInsert(q: string, values: unknown[]) {
  const m = q.match(/^INSERT OR IGNORE INTO (\w+) \(([^)]+)\)/);
  if (!m || !tables[m[1]]) return;
  const cols = m[2].split(',').map((c) => c.trim());
  const row: Record<string, unknown> = { id: m[1] === 'tv_series' ? 100 + nextId++ : m[1] === 'episodes' ? epId++ : nextId++ };
  cols.forEach((c, i) => (row[c] = values[i]));
  const list = tables[m[1]] as unknown as Record<string, unknown>[];
  if (row.file_path && list.some((r) => r.file_path === row.file_path)) return;
  if (m[1] === 'tv_series' && list.some((r) => r.tmdb_id === row.tmdb_id)) return;
  list.push(row);
}

function handleLibrarySql(q: string, values: unknown[]): unknown | undefined {
  let m: RegExpMatchArray | null;
  if ((m = q.match(/^SELECT \* FROM (movies|episodes) WHERE id IN \(([^)]*)\)/))) {
    const ids = m[2].split(',').map(Number);
    return tables[m[1]].filter((r) => ids.includes(r.id));
  }
  if (q.startsWith('SELECT * FROM tv_series WHERE id = $1')) return series.filter((s) => s.id === values[0]);
  if ((m = q.match(/^SELECT id FROM (movies|episodes) WHERE file_path = \$1/)))
    return (tables[m[1]] as unknown as { id: number; file_path: string }[]).filter((r) => r.file_path === values[0]).map((r) => ({ id: r.id }));
  if (q.startsWith('SELECT id FROM tv_series WHERE tmdb_id = $1'))
    return series.filter((s) => s.tmdb_id === values[0]).map((s) => ({ id: s.id }));
  if (q.startsWith('SELECT * FROM trash')) return [...trash].reverse();
  if (q.startsWith('INSERT INTO trash')) {
    const [label, kind, poster_path, entry_dir, items, snapshot, size_bytes] = values as [string, TrashRow['kind'], string, string, string, string, number];
    trash.push({ id: trashId++, label, kind, poster_path, entry_dir, items, snapshot, size_bytes, deleted_at: ts(0) });
    return [1, 0];
  }
  if (q.startsWith('DELETE FROM trash WHERE id')) {
    const i = trash.findIndex((t) => t.id === values[0]);
    if (i >= 0) trash.splice(i, 1);
    return [1, 0];
  }
  if ((m = q.match(/^DELETE FROM (movies|episodes) WHERE id = \$1/))) {
    const list = tables[m[1]];
    const i = list.findIndex((r) => r.id === values[0]);
    if (i >= 0) list.splice(i, 1);
    return [1, 0];
  }
  if (q.startsWith('DELETE FROM tv_series WHERE id NOT IN')) {
    for (let i = series.length - 1; i >= 0; i--) if (!episodes.some((e) => e.series_id === series[i].id)) series.splice(i, 1);
    return [1, 0];
  }
  if (q.startsWith('INSERT OR IGNORE INTO') && !q.includes('subtitles')) {
    genericInsert(q, values);
    return [1, 0];
  }
  return undefined;
}

function handleExecute(query: string, values: unknown[]) {
  const q = query.replace(/\s+/g, ' ').trim();
  const lib = handleLibrarySql(q, values);
  if (lib !== undefined) return lib;
  if (/subtitles/.test(q) && !q.startsWith('CREATE')) return handleSubtitleSql(q, values);
  let m: RegExpMatchArray | null;
  if ((m = q.match(/UPDATE (movies|tv_series) SET my_list = \$1 WHERE id = \$2/))) {
    const rows = m[1] === 'movies' ? movies : series;
    const row = rows.find((r) => r.id === values[1]);
    if (row) row.my_list = values[0] as number;
  } else if ((m = q.match(/UPDATE (movies|episodes) SET watched = 1, progress_seconds = 0, duration_seconds = \$1/))) {
    const rows: (MovieRow | EpisodeRow)[] = m[1] === 'movies' ? movies : episodes;
    const row = rows.find((r) => r.id === values[1]);
    if (row) Object.assign(row, { watched: 1, progress_seconds: 0, duration_seconds: values[0], last_watched_at: ts(0) });
  } else if ((m = q.match(/UPDATE (movies|episodes) SET watched = 0, progress_seconds = \$1, duration_seconds = \$2/))) {
    const rows: (MovieRow | EpisodeRow)[] = m[1] === 'movies' ? movies : episodes;
    const row = rows.find((r) => r.id === values[2]);
    if (row) Object.assign(row, { watched: 0, progress_seconds: values[0], duration_seconds: values[1], last_watched_at: ts(0) });
  } else if ((m = q.match(/UPDATE (movies|episodes) SET watched = \$1, progress_seconds = 0, last_watched_at = (CURRENT_TIMESTAMP|NULL)/))) {
    const rows: (MovieRow | EpisodeRow)[] = m[1] === 'movies' ? movies : episodes;
    const row = rows.find((r) => r.id === values[1]);
    if (row) Object.assign(row, { watched: values[0], progress_seconds: 0, last_watched_at: m[2] === 'NULL' ? null : ts(0) });
  } else if (q.includes('UPDATE tv_series SET last_watched_at = CURRENT_TIMESTAMP')) {
    const ep = episodes.find((e) => e.id === values[0]);
    const s = series.find((x) => x.id === ep?.series_id);
    if (s) s.last_watched_at = ts(0);
  } else if (q.startsWith('INSERT INTO settings')) {
    settings[values[0] as string] = values[1] as string;
  }
  return [1, 0];
}

function handleSelect(query: string, values: unknown[]) {
  const lib = handleLibrarySql(query.replace(/\s+/g, ' ').trim(), values);
  if (lib !== undefined) return lib;
  if (query.includes('FROM subtitles')) return handleSubtitleSql(query.replace(/\s+/g, ' ').trim(), values);
  if (query.includes('FROM settings')) return Object.entries(settings).map(([key, value]) => ({ key, value }));
  if (query.startsWith('SELECT * FROM movies')) return movies;
  if (query.startsWith('SELECT * FROM tv_series')) return series;
  if (query.startsWith('SELECT * FROM episodes')) return episodes;
  return [];
}

// --- Simulated built-in player engine (mirrors the Rust `player_*` commands and events) ---------

interface SimState {
  time: number; duration: number; paused: boolean; eof: boolean; buffering: boolean; seeking: boolean; idle: boolean;
  volume: number; muted: boolean; speed: number; sub_delay: number; audio_delay: number; gamma: string | null; loaded: boolean;
}
let sim: { state: SimState; timer: number; tracks: Record<string, unknown>[] } | null = null;
const simDuration = () => Number((window as unknown as { __simDuration?: number }).__simDuration) || 3300;

const simTracks = () => [
  { id: 1, type: 'video', codec: 'hevc', selected: true },
  { id: 1, type: 'audio', lang: 'eng', codec: 'truehd', 'codec-desc': 'TrueHD (Dolby Atmos)', 'demux-channel-count': 8, default: true, selected: true },
  { id: 2, type: 'audio', lang: 'jpn', codec: 'eac3', 'demux-channel-count': 6, title: 'Japanese Dub', selected: false },
  { id: 1, type: 'sub', lang: 'eng', codec: 'subrip', selected: false },
  { id: 2, type: 'sub', lang: 'eng', codec: 'hdmv_pgs_subtitle', 'hearing-impaired': true, selected: false },
  { id: 3, type: 'sub', lang: 'spa', codec: 'ass', forced: true, selected: false },
];

function simEmit() {
  if (!sim) return;
  void emit('player-state', { ...sim.state });
}

function simOpen(start: number) {
  if (sim) window.clearInterval(sim.timer);
  const state: SimState = {
    time: start, duration: simDuration(), paused: false, eof: false, buffering: false, seeking: false, idle: false,
    volume: 100, muted: false, speed: 1, sub_delay: 0, audio_delay: 0, gamma: 'pq', loaded: false,
  };
  const tracks = simTracks();
  sim = {
    state,
    tracks,
    timer: window.setInterval(() => {
      if (!sim) return;
      const s = sim.state;
      if (!s.loaded) {
        s.loaded = true;
        void emit('player-tracks', JSON.stringify(sim.tracks));
      } else if (!s.paused && !s.eof) {
        s.time = Math.min(s.duration, s.time + 0.2 * s.speed * ((window as unknown as { __simRate?: number }).__simRate ?? 1));
        if (s.time >= s.duration) s.eof = true;
      }
      simEmit();
    }, 200),
  };
}

function simCommand(args: string[]) {
  if (!sim) throw new Error('No active playback');
  const s = sim.state;
  const [cmd, a, b] = args;
  if (cmd === 'cycle' && a === 'pause') s.paused = !s.paused;
  else if (cmd === 'cycle' && a === 'mute') s.muted = !s.muted;
  else if (cmd === 'add' && a === 'volume') s.volume = Math.max(0, Math.min(130, s.volume + Number(b)));
  else if (cmd === 'seek') {
    s.time = Math.max(0, Math.min(s.duration, b === 'absolute' ? Number(a) : s.time + Number(a)));
    s.eof = s.time >= s.duration;
  }
  simEmit();
}

function simSet(name: string, value: string) {
  if (!sim) throw new Error('No active playback');
  const s = sim.state;
  if (name === 'volume') s.volume = Number(value);
  else if (name === 'mute') s.muted = value === 'yes';
  else if (name === 'speed') s.speed = Number(value);
  else if (name === 'sub-delay') s.sub_delay = Number(value);
  else if (name === 'audio-delay') s.audio_delay = Number(value);
  else if (name === 'aid' || name === 'sid') {
    const type = name === 'aid' ? 'audio' : 'sub';
    for (const t of sim.tracks) if (t.type === type) t.selected = value !== 'no' && t.id === Number(value);
    void emit('player-tracks', JSON.stringify(sim.tracks));
  }
  simEmit();
}

function simClose() {
  if (!sim) return;
  window.clearInterval(sim.timer);
  const final = { ...sim.state };
  sim = null;
  void emit('player-closed', final);
}

export function installMocks() {
  mockWindows('main');
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case 'plugin:sql|load':
          return a.db;
        case 'plugin:sql|execute':
          return handleExecute(String(a.query), (a.values as unknown[]) ?? []);
        case 'plugin:sql|select':
          return handleSelect(String(a.query), (a.values as unknown[]) ?? []);
        case 'subtitle_hash':
          return '8e245d9679d31e12';
        case 'opensubtitles_verify':
          return { logged_in: false, allowed_downloads: 5 };
        case 'opensubtitles_search':
          (window as unknown as { __lastSubSearch: unknown }).__lastSubSearch = a.params;
          return new Promise((r) => setTimeout(() => r(mockSubtitleResults), 300));
        case 'opensubtitles_download': {
          const video = String(a.videoPath);
          return { path: `${video.replace(/\.[^.]+$/, '')}.${a.language}.srt`, remaining: 4, message: null };
        }
        case 'list_local_subtitles':
          return String(a.videoPath).endsWith('S01E01.mkv')
            ? [{ path: String(a.videoPath).replace('.mkv', '.es.srt'), file_name: 'S01E01.es.srt', language: 'es' }]
            : [];
        case 'delete_subtitle_file':
          return null;
        case 'player_status':
          return { available: true, reason: null, mpv_version: 'mpv v0.41.0', ffmpeg_version: 'n7.1.1', library: '/opt/homebrew/lib/libmpv.2.dylib' };
        case 'player_open':
          (window as unknown as { __lastPlayerOpen: unknown }).__lastPlayerOpen = a;
          simOpen(Number(a.startTime) || 0);
          return null;
        case 'player_command':
          simCommand(a.args as string[]);
          return null;
        case 'player_set':
          simSet(String(a.name), String(a.value));
          return null;
        case 'player_close':
          simClose();
          return null;
        case 'plugin:app|version':
          return '0.1.0';
        case 'plugin:updater|check':
          return (window as unknown as { __mockUpdate?: boolean }).__mockUpdate
            ? { rid: 1, currentVersion: '0.1.0', version: '0.2.0', date: new Date().toISOString(), body: 'Built-in player improvements\nWindows support', rawJson: {} }
            : null;
        case 'plugin:window|is_fullscreen':
          return false;
        case 'plugin:window|set_fullscreen':
          return null;
        case 'imdb_lookup':
          return { ratings: {}, episodes: [], updated: 0 };
        case 'organize_loose_files':
          return { moved: [], errors: [] };
        case 'trash_media': {
          const paths = a.videoPaths as string[];
          const entry = `${a.root || '/Volumes/Media'}/.truongflix-trash/${Date.now()}`;
          return {
            entry_dir: entry,
            items: paths.map((p, i) => ({ from: p, to: `${entry}/${i}/${p.split('/').pop()}` })),
            size_bytes: paths.length * 4.3e9,
          };
        }
        case 'restore_trash':
          return { restored: (a.items as unknown[]).length, conflicts: [] };
        case 'purge_trash':
          return null;
        case 'reveal_in_file_manager':
          (window as unknown as { __lastReveal: unknown }).__lastReveal = a.path;
          return null;
        case 'detect_vlc':
          return '/Applications/VLC.app/Contents/MacOS/VLC';
        case 'check_paths':
          return ((a.paths as string[]) ?? []).map(() => true);
        case 'scan_media_folders':
          return new Promise((resolve) => setTimeout(() => resolve([]), 1500));
        case 'launch_vlc': {
          (window as unknown as { __lastLaunch: unknown }).__lastLaunch = a;
          // Simulate a short VLC session: two progress ticks, then exit.
          const base = { media_type: a.mediaType, media_id: a.mediaId };
          const length = 3300;
          const start = Number(a.startTime) || 0;
          setTimeout(() => emit('vlc-progress', { ...base, time: start + 600, length }), 800);
          setTimeout(() => emit('vlc-progress', { ...base, time: start + 1200, length }), 2000);
          setTimeout(() => emit('vlc-exited', { ...base, final_time: start + 1200, length }), 4000);
          return null;
        }
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
