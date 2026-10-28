/**
 * Dev-only browser preview: fakes the Tauri IPC layer (SQLite, VLC, scanner) with fixture
 * data so the UI can be developed in a regular browser via `npm run dev`.
 * Never included in production builds (guarded by import.meta.env.DEV in main.tsx).
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type {
  EpisodeRow,
  InspectTorrentRes,
  MediaInfo,
  MovieRow,
  SeriesRow,
  SubtitleRow,
  TorrentRecord,
  TorrentStatus,
  TrashRow,
  WatchLogRow,
} from '../types/media';

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
    certification: 'PG-13',
    collection_id: 0,
    collection_name: null,
    trailer_key: '',
    file_size: 42e9,
    media_info: null,
    segments: null,
    probed_mtime: 0,
    enriched_at: ts(1),
    probe_error: null,
    rt_score: null,
    metacritic: null,
    omdb_at: null,
    stinger: '',
    subs_auto_at: null,
    subs_auto_result: null,
    ...extra,
  };
}

const cast = (...names: string[]) =>
  JSON.stringify([...names.map((n, i) => ({ id: 1000 + n.length * 31 + i, name: n })), { id: 525, name: 'Christopher Nolan', job: 'Director' }]);

const mediaInfo = (w: number, h: number, gamma: string, dv: number | null, chapters: { title: string; time: number }[] = []): string =>
  JSON.stringify({
    duration: 8160, width: w, height: h, video_codec: 'hevc', video_profile: 'Main 10', gamma, primaries: 'bt.2020', dv_profile: dv, size: 58e9,
    audio: [
      { lang: 'eng', title: 'TrueHD Atmos 7.1', codec: 'truehd', profile: 'TrueHD + Atmos', channels: 8, default: true },
      { lang: 'eng', title: 'Commentary', codec: 'ac3', profile: null, channels: 2, default: false },
    ],
    subs: [{ lang: 'eng', title: null, codec: 'subrip', forced: false }],
    chapters,
  } satisfies MediaInfo);

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
    certification: 'R',
    rt_score: 83,
    metacritic: 73,
    stinger: 'after',
    collection_id: 2344,
    collection_name: 'The Matrix Collection',
    trailer_key: 'vKQi3bBA1y8',
    media_info: mediaInfo(3840, 1600, 'pq', 8, [
      { title: 'Opening', time: 0 }, { title: 'Wake Up, Neo', time: 410 }, { title: 'The Red Pill', time: 1820 },
      { title: 'The Construct', time: 3050 }, { title: 'The Oracle', time: 4300 }, { title: 'Lobby', time: 6100 }, { title: 'End Credits', time: 7800 },
    ]),
    segments: JSON.stringify([{ kind: 'credits', start: 7800, end: 8160, source: 'chapter' }]),
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
    certification: 'PG-13',
    collection_id: 726871,
    collection_name: 'Dune Collection',
    trailer_key: 'Way9Dexny3w',
    my_list: 1,
  }),
  movie('Dune: Part Two', 693134, 2024, ['eZ239CUp1d6OryZEBPnO2n87gMG.jpg', '6izwz7rsy95ARzTR3poZ8H6c5pp.jpg', 'ofo16Av8ssvqmGauI2kZsdiBbm2.png'], {
    file_path: '/Volumes/Media/Movies/Dune.Part.Two.2024.1080p.WEB-DL.mkv',
    raw_filename: 'Dune.Part.Two.2024.1080p.WEB-DL.mkv',
    runtime: 167,
    genres: '["Science Fiction","Adventure"]',
    ...tech('HD', null, 'H.264', '5.1'),
    file_size: 9.8e9,
    certification: 'PG-13',
    collection_id: 726871,
    collection_name: 'Dune Collection',
  }),
  movie('Dune', 438631, 2021, ['jYEW5xZkZk2WTrdbMGAPFuBqbDc.jpg', 'd5NXSklXo0qyIYkgV94XAgMIckC.jpg', 'ofo16Av8ssvqmGauI2kZsdiBbm2.png'], {
    overview: 'Paul Atreides, a brilliant and gifted young man born into a great destiny beyond his understanding, must travel to the most dangerous planet in the universe to ensure the future of his family and his people.',
    runtime: 155,
    vote_average: 7.8,
    genres: '["Science Fiction","Adventure"]',
    cast_crew: cast('Timothée Chalamet', 'Rebecca Ferguson', 'Oscar Isaac', 'Zendaya'),
    ...tech('4K', 'HDR10', 'HEVC', 'Atmos, 5.1'),
    certification: 'PG-13',
    collection_id: 726871,
    collection_name: 'Dune Collection',
    created_at: ts(9),
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
    certification: 'R',
    media_info: JSON.stringify({ ...JSON.parse(mediaInfo(1920, 1080, 'bt.1886', null)), duration: 10860, tail_ok: false, subs: [] }),
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
    certification: 'R',
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
    certification: 'PG-13',
    file_size: 1.2e9,
    media_info: JSON.stringify({ ...JSON.parse(mediaInfo(1920, 800, 'bt.1886', null)), duration: 8880, size: 1.2e9, subs: [] }),
  }),
  movie('Paddington 2', 346648, 2017, ['p3vu3MXuW9mH4OlVPMxDaKN3aEz.jpg', '1OJ9vkD5xPt3skC6KguyXAgagRZ.jpg', 'tMfBgvYbXTkmYB4KDUAcIbKcqwV.png'], {
    overview: 'Paddington, now happily settled with the Browns, picks up a series of odd jobs to buy the perfect present for his Aunt Lucy, but it is stolen.',
    runtime: 104,
    vote_average: 7.6,
    genres: '["Comedy","Family","Adventure"]',
    cast_crew: cast('Ben Whishaw', 'Hugh Grant', 'Sally Hawkins'),
    ...tech('HD', null, 'H.264', '5.1'),
    certification: 'PG',
    created_at: ts(4),
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
    certification: null,
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
  cast_crew: JSON.stringify([
    { id: 18, name: 'Adam Scott' }, { id: 19, name: 'Britt Lower' }, { id: 20, name: 'Patricia Arquette' },
    { id: 21, name: 'John Turturro' }, { id: 22, name: 'Ben Stiller', job: 'Creator' },
  ]),
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
  certification: ['TV-MA', 'TV-MA', 'TV-14'][i],
  trailer_key: ['xEQP4VVuyrY', 'HhesaQXLuRY', 'b9EkMc79ZSU'][i],
  tmdb_status: ['Returning Series', 'Ended', 'Returning Series'][i],
  next_episode: i === 0 ? JSON.stringify({ season: 2, episode: 7, name: 'Chikhai Bardo', air_date: new Date(now.getTime() + 3 * 864e5).toISOString().slice(0, 10) }) : null,
  enriched_at: ts(0.5),
  rt_score: [97, 96, 92][i],
  metacritic: [83, 87, 76][i],
  omdb_at: ts(1),
}));

let epId = 1000;
const episodes: EpisodeRow[] = [];
const extraCopies: EpisodeRow[] = [];
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
        file_size: 4.2e9,
        media_info: null,
        segments: JSON.stringify([
          ...(e > 1 ? [{ kind: 'recap', start: 0, end: 38, source: 'chapter' }] : []),
          { kind: 'intro', start: 62, end: 112, source: 'audio' },
          { kind: 'credits', start: 3180, end: 3300, source: 'chapter' },
        ]),
        probed_mtime: 0,
        intro_checked: 1,
        probe_error: null,
        subs_auto_at: null,
        subs_auto_result: null,
        // Library-health samples: an unreadable file and some 720p episodes.
        ...(s.id === 101 && season === 2 && e === 4 ? { probe_error: 'couldn’t be opened or decoded', resolution: null } : {}),
        ...(s.id === 102 && season === 1 ? { resolution: '720p', hdr_format: null, file_size: 0.9e9 } : {}),
      });
    }
}

// A second copy of Severance S1E2 (library-health duplicate sample).
{
  const e2 = episodes.find((e) => e.series_id === 100 && e.season_number === 1 && e.episode_number === 2)!;
  extraCopies.push({ ...e2, id: epId++, file_path: e2.file_path.replace('S01E02.mkv', 'Severance.S01E02.720p.HDTV.mkv'), resolution: '720p', hdr_format: null, file_size: 1.1e9, progress_seconds: 0, watched: 0, last_watched_at: null });
  episodes.push(...extraCopies);
  episodes.sort((a, b) => a.series_id - b.series_id || a.season_number - b.season_number || a.episode_number - b.episode_number);
}

const settings: Record<string, string> = {
  tmdb_api_key: 'dev-mock-key',
  vlc_executable_path: '/Applications/VLC.app/Contents/MacOS/VLC',
  media_directories: '["/Volumes/Media/Movies","/Volumes/Media/Shows"]',
  opensubtitles_api_key: 'dev-mock-os-key',
  subtitle_language: 'en',
  imdb_last_sync: new Date().toISOString(),
  omdb_api_key: 'dev-omdb-key',
};

// --- Profiles & per-profile state -------------------------------------------------------------

const profiles = [
  { id: 1, name: 'Ian', color: '#E50914', maturity: 'all', created_at: ts(30), daily_limit: 0, bedtime: '', wake_time: '07:00', pin: '1234' },
  { id: 2, name: 'Kids', color: '#F5B70A', maturity: 'kids', created_at: ts(20), daily_limit: 60, bedtime: '20:00', wake_time: '07:00', pin: '' },
];
type StateRow = { progress_seconds: number; duration_seconds: number; watched: number; my_list: number; last_watched_at: string | null };
const state = new Map<string, StateRow>();
const stateKey = (p: unknown, t: unknown, id: unknown) => `${p}|${t}|${id}`;
for (const m of movies) state.set(stateKey(1, 'movie', m.id), { ...m });
for (const e of episodes) state.set(stateKey(1, 'episode', e.id), { ...e, my_list: 0 });
for (const x of series) state.set(stateKey(1, 'tv', x.id), { progress_seconds: 0, duration_seconds: 0, watched: 0, my_list: x.my_list, last_watched_at: x.last_watched_at });

function withPs(rows: object[], type: string, profile: unknown) {
  return rows.map((r) => {
    const st = state.get(stateKey(profile, type, (r as { id: number }).id));
    return { ...r, ps_progress: st?.progress_seconds ?? null, ps_duration: st?.duration_seconds ?? null, ps_watched: st?.watched ?? null, ps_my_list: st?.my_list ?? null, ps_last: st?.last_watched_at ?? null };
  });
}

function upsertProfileState(q: string, values: unknown[]) {
  const cols = q.match(/media_id, ([^)]+)\)/)![1].split(',').map((c) => c.trim());
  const vals = q.match(/VALUES \(\$1, \$2, \$3, ([^)]+)\)/)![1].split(',').map((c) => c.trim());
  const key = stateKey(values[0], values[1], values[2]);
  const row = state.get(key) ?? { progress_seconds: 0, duration_seconds: 0, watched: 0, my_list: 0, last_watched_at: null };
  cols.forEach((c, i) => {
    const v = vals[i] === 'CURRENT_TIMESTAMP' ? ts(0) : values[Number(vals[i].slice(1)) - 1];
    (row as Record<string, unknown>)[c] = v;
  });
  state.set(key, row);
}

// Viewing history for the Wrapped / Viewing Activity screens.
const watchLog: WatchLogRow[] = [];
{
  const year = now.getFullYear();
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let d = 0; d < 300; d += 1 + Math.floor(rand() * 3)) {
    const day = new Date(now.getTime() - d * 864e5);
    if (day.getFullYear() !== year) break;
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    if (rand() < 0.55) {
      const e = episodes[Math.floor(rand() * episodes.length)];
      const show = series.find((x) => x.id === e.series_id)!;
      const n = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) {
        const ep = episodes.find((x) => x.series_id === e.series_id && x.id === e.id + k) ?? e;
        watchLog.push({ profile_id: 1, media_type: 'episode', media_id: ep.id, day: iso, seconds: 2400 + rand() * 900, title: ep.title, series_id: show.id,
          series_title: show.title, genres: show.genres, season_number: ep.season_number, episode_number: ep.episode_number, poster: show.poster_path });
      }
    } else {
      const m = movies[Math.floor(rand() * (movies.length - 1))];
      watchLog.push({ profile_id: 1, media_type: 'movie', media_id: m.id, day: iso, seconds: 3600 + rand() * 4000, title: m.title, series_id: null,
        series_title: null, genres: m.genres, season_number: null, episode_number: null, poster: m.poster_path });
    }
  }
}

const collections = [
  {
    id: 726871, name: 'Dune Collection', overview: 'The saga of Paul Atreides.', poster_path: null, backdrop_path: `${IMG}/original/eZ239CUp1d6OryZEBPnO2n87gMG.jpg`, fetched_at: ts(1),
    parts: JSON.stringify([
      { tmdb_id: 438631, title: 'Dune', year: 2021, release_date: '2021-09-15', poster: `${IMG}/w342/d5NXSklXo0qyIYkgV94XAgMIckC.jpg`, backdrop: null, overview: '' },
      { tmdb_id: 693134, title: 'Dune: Part Two', year: 2024, release_date: '2024-02-27', poster: `${IMG}/w342/6izwz7rsy95ARzTR3poZ8H6c5pp.jpg`, backdrop: null, overview: '' },
      { tmdb_id: 1170608, title: 'Dune: Part Three', year: 2026, release_date: '2026-12-16', poster: null, backdrop: null, overview: 'The third chapter.' },
    ]),
  },
  {
    id: 2344, name: 'The Matrix Collection', overview: null, poster_path: null, backdrop_path: null, fetched_at: ts(1),
    parts: JSON.stringify([
      { tmdb_id: 603, title: 'The Matrix', year: 1999, release_date: '1999-03-31', poster: null, backdrop: null, overview: '' },
      { tmdb_id: 604, title: 'The Matrix Reloaded', year: 2003, release_date: '2003-05-15', poster: null, backdrop: null, overview: '' },
    ]),
  },
];

/** TMDB season lists: Severance has episodes 6–10 that aren't in the library (some unaired). */
function seasonCache(tmdbId: number) {
  const show = series.find((x) => x.tmdb_id === tmdbId);
  if (!show) return [];
  return [1, 2].map((season) => ({
    season_number: season,
    fetched_at: ts(0.2),
    episodes: JSON.stringify(
      Array.from({ length: show.id === 100 ? (season === 1 ? 9 : 10) : 5 }, (_, i) => ({
        episode_number: i + 1,
        name: `Episode ${i + 1}`,
        overview: 'An episode you don’t have yet.',
        still_path: null,
        air_date: new Date(now.getTime() + (season === 2 ? (i - 6) * 7 + 3 : -400 + i * 7) * 864e5).toISOString().slice(0, 10),
        runtime: 52,
      })),
    ),
  }));
}

const renameBatches: { id: number; created_at: string; label: string; moves: string; roots: string; undone: number }[] = [];

function handleProfileSql(q: string, values: unknown[]): unknown | undefined {
  if (q.startsWith('SELECT COUNT(*) AS n FROM profiles')) return [{ n: profiles.length }];
  if (q.startsWith('SELECT * FROM profiles')) return profiles;
  if (q.startsWith('INSERT INTO profiles')) {
    const id = Math.max(0, ...profiles.map((x) => x.id)) + 1;
    const [name, color, maturity, daily_limit, bedtime, wake_time, pin] = values as [string, string, string, number, string, string, string];
    profiles.push({ id, name, color, maturity, created_at: ts(0), daily_limit: daily_limit ?? 0, bedtime: bedtime ?? '', wake_time: wake_time ?? '07:00', pin: pin ?? '' });
    return [1, id];
  }
  if (q.startsWith('UPDATE profiles')) {
    const pr = profiles.find((x) => x.id === values[0]);
    if (pr) Object.assign(pr, { name: values[1], color: values[2], maturity: values[3], daily_limit: values[4], bedtime: values[5], wake_time: values[6], pin: values[7] });
    return [1, 0];
  }
  if (q.startsWith('SELECT SUM(seconds) AS total FROM watch_log')) {
    const total = watchLog.filter((w) => w.profile_id === values[0] && w.day === values[1]).reduce((n, w) => n + w.seconds, 0);
    return [{ total: total + ((window as unknown as { __extraWatched?: number }).__extraWatched ?? 0) }];
  }
  if (q.startsWith('DELETE FROM profiles')) {
    const i = profiles.findIndex((x) => x.id === values[0]);
    if (i >= 0) profiles.splice(i, 1);
    return [1, 0];
  }
  if (q.startsWith('SELECT m.*')) return withPs(movies, 'movie', values[0]);
  if (q.startsWith('SELECT s.*')) return withPs(series, 'tv', values[0]);
  if (q.startsWith('SELECT e.*')) return withPs(episodes, 'episode', values[0]);
  if (q.startsWith('INSERT INTO profile_state')) {
    upsertProfileState(q, values);
    return [1, 0];
  }
  if (q.startsWith('UPDATE profile_state SET progress_seconds = 0')) {
    for (const e of episodes.filter((x) => x.series_id === values[1])) {
      const st = state.get(stateKey(values[0], 'episode', e.id));
      if (st) st.progress_seconds = 0;
    }
    return [1, 0];
  }
  if (q.includes('FROM profile_state') || q.includes('INTO profile_state')) return q.startsWith('SELECT') ? [] : [1, 0];
  if (q.startsWith('SELECT series_id FROM episodes WHERE id')) return episodes.filter((e) => e.id === values[0]).map((e) => ({ series_id: e.series_id }));
  if (q.startsWith('SELECT * FROM watch_log')) return watchLog.filter((w) => w.profile_id === values[0]).sort((a, b) => b.day.localeCompare(a.day));
  if (q.startsWith('INSERT INTO watch_log')) {
    const [profile_id, media_type, media_id, day, seconds, title, series_id, series_title, genres, season_number, episode_number, poster] = values as never[];
    const row = watchLog.find((w) => w.profile_id === profile_id && w.media_type === media_type && w.media_id === media_id && w.day === day);
    if (row) row.seconds += seconds;
    else watchLog.push({ profile_id, media_type, media_id, day, seconds, title, series_id, series_title, genres, season_number, episode_number, poster });
    return [1, 0];
  }
  if (q.startsWith('DELETE FROM watch_log WHERE profile_id = $1 AND')) {
    const i = watchLog.findIndex((w) => w.profile_id === values[0] && w.media_type === values[1] && w.media_id === values[2] && w.day === values[3]);
    if (i >= 0) watchLog.splice(i, 1);
    return [1, 0];
  }
  if (/^UPDATE (movies|tv_series) SET rt_score/.test(q)) {
    const list = (q.includes('tv_series') ? series : movies) as { imdb_id: string | null; rt_score: number | null; metacritic: number | null; omdb_at: string | null }[];
    for (const r of list.filter((x) => x.imdb_id === values[0])) Object.assign(r, { rt_score: values[1], metacritic: values[2], omdb_at: ts(0) });
    return [1, 0];
  }
  if (q.startsWith('SELECT * FROM collections')) return collections;
  if (q.startsWith('SELECT season_number, episodes, fetched_at FROM season_cache')) return seasonCache(values[0] as number);
  if (q.startsWith('SELECT * FROM rename_batches')) return [...renameBatches].reverse();
  if (q.startsWith('INSERT INTO rename_batches')) {
    renameBatches.push({ id: renameBatches.length + 1, created_at: ts(0), label: values[0] as string, moves: values[1] as string, roots: values[2] as string, undone: 0 });
    return [1, 0];
  }
  if (q.startsWith('UPDATE rename_batches SET undone')) {
    const b = renameBatches.find((x) => x.id === values[0]);
    if (b) b.undone = 1;
    return [1, 0];
  }
  if (/^UPDATE (movies|episodes) SET file_path/.test(q)) {
    const list = (q.includes('movies') ? movies : episodes) as { file_path: string }[];
    const row = list.find((r) => r.file_path === values[0]);
    if (row) row.file_path = values[1] as string;
    return [1, 0];
  }
  if (/watch_log|collections|season_cache|rename_batches/.test(q)) return q.startsWith('SELECT') ? [] : [1, 0];
  return undefined;
}

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
const torrentRecords: TorrentRecord[] = [];
const tables = { movies, episodes, tv_series: series } as unknown as Record<string, { id: number }[]>;

function handleTorrentSql(q: string, values: unknown[]): unknown | undefined {
  if (!/\btorrents\b/.test(q) || q.startsWith('CREATE')) return undefined;
  if (q.startsWith('SELECT * FROM torrents')) {
    return [...torrentRecords].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  if (q.startsWith('SELECT info_hash, file_paths FROM torrents')) {
    return torrentRecords.map((r) => ({ info_hash: r.info_hash, file_paths: r.file_paths }));
  }
  if (q.startsWith('SELECT mode, completed_at, file_paths FROM torrents')) {
    return torrentRecords.map((r) => ({ mode: r.mode, completed_at: r.completed_at, file_paths: r.file_paths }));
  }
  if (q.startsWith('SELECT file_paths FROM torrents WHERE completed_at IS NULL')) {
    return torrentRecords.filter((r) => r.completed_at == null).map((r) => ({ file_paths: r.file_paths }));
  }
  if (q.startsWith('INSERT INTO torrents')) {
    const [
      info_hash,
      name,
      source,
      mode,
      save_path,
      delete_on_complete,
      cache_hours,
      expires_at,
      media_kind,
      tmdb_id,
      series_id,
      movie_id,
      file_paths,
      total_bytes,
      completed_at,
      seeding_stopped,
    ] = values as [
      string,
      string,
      string,
      TorrentRecord['mode'],
      string,
      number,
      number | null,
      string | null,
      TorrentRecord['media_kind'],
      number | null,
      number | null,
      number | null,
      string,
      number,
      string | null,
      number,
    ];
    const hash = String(info_hash).toLowerCase();
    const existing = torrentRecords.find((r) => r.info_hash === hash);
    if (existing) {
      Object.assign(existing, {
        name,
        source,
        mode,
        save_path,
        delete_on_complete,
        cache_hours,
        expires_at,
        media_kind: media_kind ?? existing.media_kind,
        tmdb_id: tmdb_id ?? existing.tmdb_id,
        series_id: series_id ?? existing.series_id,
        movie_id: movie_id ?? existing.movie_id,
        file_paths,
        total_bytes: total_bytes > 0 ? total_bytes : existing.total_bytes,
        completed_at: completed_at ?? existing.completed_at,
        seeding_stopped: Math.max(existing.seeding_stopped, seeding_stopped || 0),
      });
    } else {
      torrentRecords.push({
        info_hash: hash,
        name,
        source,
        mode,
        save_path,
        delete_on_complete,
        cache_hours,
        expires_at,
        media_kind,
        tmdb_id,
        series_id,
        movie_id,
        file_paths,
        total_bytes,
        completed_at,
        seeding_stopped,
        created_at: ts(0),
      });
    }
    return [1, 0];
  }
  if (q.startsWith('UPDATE torrents SET')) {
    const hash = String(values[0]).toLowerCase();
    const row = torrentRecords.find((r) => r.info_hash === hash);
    if (row) {
      const assignPart = q.slice('UPDATE torrents SET '.length, q.indexOf(' WHERE info_hash'));
      for (const piece of assignPart.split(',')) {
        const [col, param] = piece.split('=').map((s) => s.trim());
        const idx = Number(param.slice(1)) - 1;
        (row as unknown as Record<string, unknown>)[col] = values[idx];
      }
    }
    return [1, 0];
  }
  if (q.startsWith('DELETE FROM torrents WHERE info_hash')) {
    const hash = String(values[0]).toLowerCase();
    const idx = torrentRecords.findIndex((r) => r.info_hash === hash);
    if (idx >= 0) torrentRecords.splice(idx, 1);
    return [1, 0];
  }
  return q.startsWith('SELECT') ? [] : [1, 0];
}

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
  if ((m = q.match(/^DELETE FROM (movies|episodes) WHERE file_path IN \(([^)]+)\)/))) {
    const pathSet = new Set(values.map(String));
    const list = tables[m[1]] as unknown as { file_path: string }[];
    for (let i = list.length - 1; i >= 0; i--) if (pathSet.has(list[i].file_path)) list.splice(i, 1);
    return [1, 0];
  }
  if (q.startsWith('INSERT INTO movies (')) {
    const [
      tmdb_id, file_path, raw_filename, file_mtime, title, original_title, year, overview, tagline, runtime,
      vote_average, genres, cast_crew, poster_path, backdrop_path, logo_path, resolution, video_codec, hdr_format,
      audio_codec, imdb_id, file_size, certification, collection_id, collection_name, trailer_key, stinger,
    ] = values as never[];
    const existing = movies.find((r) => r.file_path === file_path);
    if (existing) {
      Object.assign(existing, {
        tmdb_id, raw_filename, file_mtime, title, original_title, year, overview, tagline, runtime,
        vote_average, genres, cast_crew, poster_path, backdrop_path, logo_path, resolution, video_codec, hdr_format,
        audio_codec, imdb_id, file_size, certification, collection_id, collection_name, trailer_key, stinger,
      });
      return [1, existing.id];
    }
    const id = nextId++;
    movies.push({
      id, tmdb_id, file_path, raw_filename, file_mtime, title, original_title, year, overview: overview ?? '',
      tagline, runtime, vote_average, genres: genres ?? '[]', cast_crew: cast_crew ?? '[]', poster_path, backdrop_path,
      logo_path, resolution, video_codec, hdr_format, audio_codec, imdb_id, imdb_rating: null, imdb_votes: null,
      progress_seconds: 0, duration_seconds: 0, watched: 0, my_list: 0, last_watched_at: null, created_at: ts(0),
      certification, collection_id: collection_id ?? 0, collection_name, trailer_key: trailer_key ?? '', file_size,
      media_info: null, segments: null, probed_mtime: 0, enriched_at: certification ? ts(0) : null, probe_error: null,
      rt_score: null, metacritic: null, omdb_at: null, stinger: stinger ?? '', subs_auto_at: null, subs_auto_result: null,
    });
    return [1, id];
  }
  if (q.startsWith('INSERT INTO tv_series (')) {
    const [
      tmdb_id, folder_path, title, year, overview, vote_average, genres, cast_crew, poster_path, backdrop_path,
      logo_path, number_of_seasons, imdb_id, certification, trailer_key, tmdb_status, next_episode,
    ] = values as never[];
    const existing = series.find((s) => s.tmdb_id === tmdb_id);
    if (existing) {
      Object.assign(existing, {
        folder_path: existing.folder_path ?? folder_path, title, year, overview: overview ?? '', vote_average,
        genres: genres ?? '[]', cast_crew: cast_crew ?? '[]', poster_path, backdrop_path, logo_path, number_of_seasons,
      });
      return [1, existing.id];
    }
    const id = 100 + nextId++;
    series.push({
      id, tmdb_id, folder_path, title, year, overview: overview ?? '', vote_average, genres: genres ?? '[]',
      cast_crew: cast_crew ?? '[]', poster_path, backdrop_path, logo_path, number_of_seasons: number_of_seasons ?? 1,
      my_list: 0, last_watched_at: null, created_at: ts(0), imdb_id, imdb_rating: null, imdb_votes: null,
      imdb_season_ratings: null, certification, trailer_key: trailer_key ?? '', tmdb_status, next_episode,
      enriched_at: certification ? ts(0) : null, rt_score: null, metacritic: null, omdb_at: null,
    });
    return [1, id];
  }
  if (q.startsWith('INSERT INTO episodes (')) {
    const [
      series_id, tmdb_episode_id, file_path, raw_filename, file_mtime, season_number, episode_number, title,
      overview, still_path, air_date, runtime, resolution, video_codec, hdr_format, audio_codec, file_size,
    ] = values as never[];
    const existing = episodes.find((e) => e.file_path === file_path);
    if (existing) {
      Object.assign(existing, {
        series_id, tmdb_episode_id, raw_filename, file_mtime, season_number, episode_number, title, overview,
        still_path, air_date, runtime, resolution, video_codec, hdr_format, audio_codec, file_size,
      });
      return [1, existing.id];
    }
    const id = epId++;
    episodes.push({
      id, series_id, tmdb_episode_id, file_path, raw_filename, file_mtime, season_number, episode_number, title,
      overview, still_path, air_date, runtime, resolution, video_codec, hdr_format, audio_codec, imdb_id: null,
      imdb_rating: null, imdb_votes: null, progress_seconds: 0, duration_seconds: 0, watched: 0, last_watched_at: null,
      file_size, media_info: null, segments: null, probed_mtime: 0, intro_checked: 0, probe_error: null,
      subs_auto_at: null, subs_auto_result: null,
    });
    return [1, id];
  }
  if (q.startsWith('INSERT OR IGNORE INTO') && !q.includes('subtitles')) {
    genericInsert(q, values);
    return [1, 0];
  }
  return undefined;
}

function handleExecute(query: string, values: unknown[]) {
  const q = query.replace(/\s+/g, ' ').trim();
  const tor = handleTorrentSql(q, values);
  if (tor !== undefined) return tor;
  const prof = handleProfileSql(q, values);
  if (prof !== undefined) return prof;
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
  const qNorm = query.replace(/\s+/g, ' ').trim();
  const tor = handleTorrentSql(qNorm, values);
  if (tor !== undefined) return tor;
  const prof = handleProfileSql(qNorm, values);
  if (prof !== undefined) return prof;
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
  { id: 4, type: 'sub', lang: 'eng', codec: 'subrip', external: true, 'external-filename': '/Volumes/Media/Shows/Severance/Season 1/S01E03.en.srt', selected: false },
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
        const d = s.duration;
        void emit('player-chapters', JSON.stringify([
          { title: 'Previously On', time: 0 }, { title: 'Opening Credits', time: 62 }, { title: 'Act One', time: 112 },
          { title: 'Act Two', time: d * 0.35 }, { title: 'Act Three', time: d * 0.7 }, { title: 'End Credits', time: d - 120 },
        ]));
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

/** Mock OMDb + TMDB (when using dev-mock-key) so browser dev & automated UI tests work offline. */
function mockOmdb() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('api.themoviedb.org/3/') && url.includes('api_key=dev-mock-key')) {
      const u = new URL(url);
      const p = u.pathname.replace('/3', '');
      const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (p === '/search/movie') {
        const q = (u.searchParams.get('query') ?? '').toLowerCase();
        if (q.includes('arrival')) {
          return jsonRes({
            results: [
              { id: 329865, title: 'Arrival', release_date: '2016-11-10', overview: 'Taking place after alien crafts land around the world, an expert linguist is recruited by the military to determine whether they come in peace or are a threat.', poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg', backdrop_path: '/yIZ1xendyqKvY3FGeeUYUd5X9Mm.jpg', vote_average: 7.6 },
            ],
          });
        }
        return jsonRes({
          results: [
            { id: 157336, title: 'Interstellar', release_date: '2014-11-05', overview: 'Explorers travel through a wormhole in space.', poster_path: '/yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg', backdrop_path: '/8sNiAPPYU14PUepFNeSNGUTiHW.jpg', vote_average: 8.5 },
            { id: 329865, title: 'Arrival', release_date: '2016-11-10', overview: 'Linguist communicates with extraterrestrial visitors.', poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg', backdrop_path: '/yIZ1xendyqKvY3FGeeUYUd5X9Mm.jpg', vote_average: 7.6 },
          ],
        });
      }
      if (p === '/search/tv') {
        const q = (u.searchParams.get('query') ?? '').toLowerCase();
        if (q.includes('andor')) {
          return jsonRes({
            results: [
              { id: 83867, name: 'Andor', first_air_date: '2022-09-21', overview: 'Cassian Andor embarks on a path that is destined to turn him into a rebel hero.', poster_path: '/59SVNwLfoMnZPPB6ukW6dlPxAdI.jpg', backdrop_path: '/ajztm40qDPqMONaSJhQ2PaNe2Xd.jpg', vote_average: 8.2 },
            ],
          });
        }
        return jsonRes({
          results: [
            { id: 83867, name: 'Andor', first_air_date: '2022-09-21', overview: 'Cassian Andor embarks on a rebel journey.', poster_path: '/59SVNwLfoMnZPPB6ukW6dlPxAdI.jpg', backdrop_path: '/ajztm40qDPqMONaSJhQ2PaNe2Xd.jpg', vote_average: 8.2 },
          ],
        });
      }
      if (p.startsWith('/movie/')) {
        const id = Number(p.split('/')[2]) || 329865;
        return jsonRes({
          id,
          title: id === 329865 ? 'Arrival' : 'Interstellar',
          original_title: id === 329865 ? 'Arrival' : 'Interstellar',
          release_date: id === 329865 ? '2016-11-10' : '2014-11-05',
          overview: 'Linguist Louise Banks leads an elite team of investigators when gigantic spaceships touch down across the globe.',
          tagline: 'Why are they here?',
          runtime: 116,
          vote_average: 7.6,
          imdb_id: 'tt2543164',
          poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg',
          backdrop_path: '/yIZ1xendyqKvY3FGeeUYUd5X9Mm.jpg',
          genres: [{ name: 'Science Fiction' }, { name: 'Drama' }],
          credits: { cast: [{ id: 9273, name: 'Amy Adams' }, { id: 17604, name: 'Jeremy Renner' }], crew: [{ id: 137427, name: 'Denis Villeneuve', job: 'Director' }] },
          images: { logos: [] },
          release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }] },
          videos: { results: [] },
          keywords: { keywords: [] },
        });
      }
      if (/^\/tv\/\d+\/season\/\d+$/.test(p)) {
        const seasonNum = Number(p.split('/')[4]) || 1;
        return jsonRes({
          episodes: [1, 2, 3].map((epNum) => ({
            id: 50000 + seasonNum * 100 + epNum,
            season_number: seasonNum,
            episode_number: epNum,
            name: `Episode ${epNum}`,
            overview: `Andor Season ${seasonNum} Episode ${epNum} synopsis.`,
            still_path: '/ajztm40qDPqMONaSJhQ2PaNe2Xd.jpg',
            air_date: '2022-09-21',
            runtime: 45,
          })),
        });
      }
      if (p.startsWith('/tv/')) {
        const id = Number(p.split('/')[2]) || 83867;
        return jsonRes({
          id,
          name: 'Andor',
          first_air_date: '2022-09-21',
          overview: 'Cassian Andor embarks on a path that is destined to turn him into a rebel hero.',
          vote_average: 8.2,
          number_of_seasons: 2,
          status: 'Returning Series',
          poster_path: '/59SVNwLfoMnZPPB6ukW6dlPxAdI.jpg',
          backdrop_path: '/ajztm40qDPqMONaSJhQ2PaNe2Xd.jpg',
          genres: [{ name: 'Sci-Fi & Fantasy' }, { name: 'Action & Adventure' }],
          credits: { cast: [{ id: 8688, name: 'Diego Luna' }], crew: [{ id: 19303, name: 'Tony Gilroy', job: 'Creator' }] },
          external_ids: { imdb_id: 'tt9253284' },
          images: { logos: [] },
          content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-14' }] },
          videos: { results: [] },
        });
      }
    }
    if (!url.includes('omdbapi.com')) return realFetch(input, init);
    const id = new URL(url).searchParams.get('i');
    const show = series.find((x) => x.imdb_id === id);
    const body = show
      ? { Response: 'True', Type: 'series', Ratings: [{ Source: 'Internet Movie Database', Value: '8.6/10' }], Metascore: 'N/A' }
      : { Response: 'True', Type: 'movie', Ratings: [{ Source: 'Rotten Tomatoes', Value: '88%' }], Metascore: '74' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

// --- Simulated BitTorrent engine (mirrors Rust `torrent_*` commands) -----------------------------

const simTorrents = new Map<string, TorrentStatus>();
let simOsDefault = { magnet_registered: false, torrent_file_registered: false, platform: 'macos' };

function hashSource(src: string): string {
  const m = src.match(/btih:([0-9a-fA-F]{40})/i);
  if (m) return m[1].toLowerCase();
  let h1 = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) h1 = Math.imul(h1 ^ src.charCodeAt(i), 0x01000193) >>> 0;
  return h1.toString(16).padStart(8, '0').repeat(5).slice(0, 40);
}

function inspectMockSource(source: string): InspectTorrentRes {
  const info_hash = hashSource(source);
  const dnMatch = source.match(/[?&]dn=([^&]+)/);
  const name = dnMatch
    ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' '))
    : source.endsWith('.torrent')
      ? source.split(/[\\/]/).pop()!.replace(/\.torrent$/i, '')
      : 'Arrival.2016.2160p.UHD.BluRay.x265.mkv';
  const isTv = /\bS\d{1,2}E\d{1,2}\b|\bS\d{1,2}\b|\bSeason\b/i.test(name);
  const files = isTv
    ? [
        { index: 0, name: `${name}.S01E01.1080p.mkv`, relative_path: `${name}.S01E01.1080p.mkv`, size: 2_200_000_000, is_video: true },
        { index: 1, name: `${name}.S01E02.1080p.mkv`, relative_path: `${name}.S01E02.1080p.mkv`, size: 2_100_000_000, is_video: true },
      ]
    : [{ index: 0, name: /\.mkv$|\.mp4$/i.test(name) ? name : `${name}.mkv`, relative_path: /\.mkv$|\.mp4$/i.test(name) ? name : `${name}.mkv`, size: 8_400_000_000, is_video: true }];
  return {
    info_hash,
    name,
    is_magnet: source.toLowerCase().startsWith('magnet:'),
    metadata_ready: true,
    total_bytes: files.reduce((s, f) => s + f.size, 0),
    files,
    trackers: ['udp://tracker.opentrackr.org:1337/announce'],
  };
}

export function installMocks() {
  mockWindows('main');
  mockOmdb();
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
        case 'player_layout':
          (window as unknown as { __lastLayout: unknown }).__lastLayout = a.rect;
          return null;
        case 'media_probe':
          return ((a.paths as string[]) ?? []).map(() => null);
        case 'extract_frames': {
          const times = a.times as number[];
          const key = String(a.key);
          // Like the real command, resolve only after every frame has been announced.
          return new Promise((resolve) => {
            times.forEach((t, i) =>
              setTimeout(() => {
                void emit('frame-ready', { lane: a.lane, key, index: i, time: t, path: `https://picsum.photos/seed/${key.slice(0, 6)}${Math.round(t)}/${a.width}/${Math.round((Number(a.width) * 9) / 16)}` });
                if (i === times.length - 1) setTimeout(() => resolve(times.map(() => null)), 50);
              }, 20 * i),
            );
            if (!times.length) resolve([]);
          });
        }
        case 'audio_devices':
          return [
            { name: 'auto', description: 'Autoselect device' },
            { name: 'coreaudio/BuiltInSpeakerDevice', description: 'MacBook Pro Speakers' },
            { name: 'coreaudio/AirPods-Pro-UID', description: 'Ian’s AirPods Pro' },
            { name: 'coreaudio/HDMI-UID', description: 'LG TV (HDMI)' },
          ];
        case 'default_audio_device':
          return (window as unknown as { __defaultDevice?: unknown }).__defaultDevice ?? { name: 'coreaudio/BuiltInSpeakerDevice', description: 'MacBook Pro Speakers' };
        case 'share_info':
          return ((a.paths as string[]) ?? []).map((p) =>
            p.startsWith('/Volumes/Media') ? { mount_point: '/Volumes/Media', url: 'smb://ian@nas.local/Media', host: 'nas.local', kind: 'smb', mac: '00:11:32:0a:bb:cc' } : null,
          );
        case 'connect_share':
          return new Promise((r) => setTimeout(() => r('ready'), 800));
        case 'sync_subtitle':
          return new Promise((resolve) => {
            [0.2, 0.5, 0.8].forEach((f, i) => setTimeout(() => void emit('subsync-progress', { fraction: f }), 200 * (i + 1)));
            setTimeout(() => resolve({ offset: -2.4, ratio: 1, confidence: 18, applied: true, message: 'Shifted -2.4 s' }), 900);
          });
        case 'undo_subtitle_sync':
          return true;
        case 'subtitle_sync_backup_exists':
          return false;
        case 'cast_discover':
          return new Promise((r) =>
            setTimeout(
              () =>
                r([
                  { id: 'cc1', name: 'Living Room TV', kind: 'chromecast', host: '192.168.1.40', port: 8009, model: 'Google TV Streamer', av_transport: null, rendering: null },
                  { id: 'tv2', name: '[LG] webOS TV OLED55', kind: 'dlna', host: '192.168.1.41', port: 1400, model: 'OLED55C3', av_transport: 'http://192.168.1.41:1400/avt', rendering: null },
                ]),
              1200,
            ),
          );
        case 'cast_start': {
          const media = a.media as { start: number; duration: number };
          let t = media.start;
          void emit('cast-status', { state: 'buffering', time: t, duration: media.duration, message: null });
          const w = window as unknown as { __castTimer?: number; __castPaused?: boolean };
          window.clearInterval(w.__castTimer);
          w.__castPaused = false;
          w.__castTimer = window.setInterval(() => {
            if (!w.__castPaused) t += 1;
            void emit('cast-status', { state: w.__castPaused ? 'paused' : 'playing', time: t, duration: media.duration, message: null });
          }, 1000);
          return null;
        }
        case 'cast_control': {
          const w = window as unknown as { __castTimer?: number; __castPaused?: boolean };
          if (a.action === 'pause') w.__castPaused = true;
          if (a.action === 'play') w.__castPaused = false;
          if (a.action === 'stop') window.clearInterval(w.__castTimer);
          return null;
        }
        case 'stream_register':
          return `tok${Math.random().toString(16).slice(2, 10)}`;
        case 'stream_url':
          return { url: `http://192.168.1.20:8732/stream/${a.token}/index.m3u8`, path: `/stream/${a.token}/index.m3u8`, offset: 0 };
        case 'stream_probe':
          return {
            duration: 3300,
            fps: 23.976,
            audio: [
              { id: 1, lang: 'eng', title: 'TrueHD Atmos 7.1', codec: 'truehd', channels: 8, default: true, selected: true },
              { id: 2, lang: 'jpn', title: 'Japanese Dub', codec: 'eac3', channels: 6, default: false, selected: false },
            ],
            subs: [
              { id: 1, lang: 'eng', title: null, codec: 'subrip', forced: false, default: true, selected: true, external: false, external_filename: null },
              { id: 2, lang: 'spa', title: 'Forced', codec: 'ass', forced: true, default: false, selected: false, external: false, external_filename: null },
            ],
            chapters: [
              { title: 'Opening Credits', time: 62 },
              { title: 'Act One', time: 112 },
              { title: 'End Credits', time: 3180 },
            ],
          };
        case 'stream_encoder':
          return 'h264_videotoolbox';
        case 'stream_release':
          return null;
        case 'remote_access_set':
          return { port: Number(a.port) || 8732, addresses: ['192.168.1.20'], web_enabled: !!a.enabled, encoder: 'h264_videotoolbox' };
        case 'server_info':
          return { port: 8732, addresses: ['192.168.1.20'], web_enabled: false, encoder: 'h264_videotoolbox' };
        case 'sidecar_subtitle_languages':
          return ((a.videoPaths as string[]) ?? []).map((p) => (p.includes('Severance/Season 1/') ? ['en'] : []));
        case 'detect_intros':
          return ((a.paths as string[]) ?? []).map(() => null);
        case 'watch_folders':
          return ((a.paths as string[]) ?? []).length;
        case 'apply_moves':
          return { applied: a.moves, errors: [] };
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
        case 'torrent_configure':
          (window as unknown as { __lastTorrentConfig?: unknown }).__lastTorrentConfig = a.config;
          return (a.config as { listen_port?: number })?.listen_port || 49152;
        case 'torrent_inspect':
        case 'torrent_inspect_files':
          return inspectMockSource(String(a.source));
        case 'torrent_add': {
          const req = a.req as {
            source: string;
            is_stream: boolean;
            output_folder?: string | null;
            sub_folder?: string | null;
            only_files?: number[] | null;
            paused?: boolean;
          };
          const info = inspectMockSource(req.source);
          const outRoot = req.is_stream
            ? `/tmp/truongflix-stream-cache/${info.info_hash}`
            : `${(req.output_folder || '/Volumes/Media/Movies').replace(/\/+$/, '')}/${req.sub_folder || info.name}`;
          const only = req.only_files ? new Set(req.only_files) : null;
          const status: TorrentStatus = {
            info_hash: info.info_hash,
            name: info.name,
            state: req.paused ? 'paused' : 'downloading',
            output_folder: outRoot,
            progress_bytes: Math.round(info.total_bytes * 0.28),
            total_bytes: info.total_bytes,
            uploaded_bytes: 0,
            progress_pct: 28,
            download_speed_bps: 18_500_000,
            upload_speed_bps: 1_200_000,
            eta_secs: 320,
            peers_live: 14,
            peers_connecting: 3,
            peers_seen: 42,
            finished: false,
            paused: !!req.paused,
            error: null,
            listen_port: 49152,
            files: info.files.map((f) => ({
              ...f,
              full_path: `${outRoot}/${f.relative_path}`,
              downloaded_bytes: Math.round(f.size * 0.28),
              included: only ? only.has(f.index) : true,
            })),
          };
          simTorrents.set(info.info_hash, status);
          return status;
        }
        case 'torrent_list': {
          const stepPct = Number((window as unknown as { __simTorrentStepPct?: number }).__simTorrentStepPct ?? 8);
          for (const st of simTorrents.values()) {
            if (!st.paused && !st.finished && stepPct > 0) {
              st.progress_pct = Math.min(100, st.progress_pct + stepPct);
              st.progress_bytes = Math.round((st.total_bytes * st.progress_pct) / 100);
              for (const f of st.files) f.downloaded_bytes = Math.round((f.size * st.progress_pct) / 100);
              if (st.progress_pct >= 100) {
                st.finished = true;
                st.state = 'seeding';
                st.download_speed_bps = 0;
                st.eta_secs = 0;
              }
            }
          }
          return [...simTorrents.values()];
        }
        case 'torrent_action': {
          const hash = String(a.infoHash).toLowerCase();
          const st = simTorrents.get(hash);
          const act = String(a.action);
          if (act === 'pause' && st) {
            st.paused = true;
            st.state = 'paused';
            st.download_speed_bps = 0;
          } else if (act === 'resume' && st) {
            st.paused = false;
            st.state = st.finished ? 'seeding' : 'downloading';
            st.download_speed_bps = st.finished ? 0 : 18_500_000;
          } else if (act === 'delete_keep_files' || act === 'delete_with_files') {
            simTorrents.delete(hash);
          }
          return null;
        }
        case 'torrent_set_only_files':
          return null;
        case 'torrent_stream_url':
          return `http://127.0.0.1:54321/torrent/mocksecret/${a.infoHash}/${a.fileIndex ?? 0}`;
        case 'torrent_take_pending_links':
          return [];
        case 'torrent_check_os_handler':
          return simOsDefault;
        case 'torrent_register_os_handler':
          simOsDefault = { ...simOsDefault, magnet_registered: true, torrent_file_registered: true };
          return simOsDefault;
        case 'plugin:deep-link|get_current':
          return null;
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
