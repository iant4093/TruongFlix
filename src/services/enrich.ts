import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EpisodeRow, MediaInfo, MovieRow, Segment } from '../types/media';
import * as db from './db';
import { parseSegments, segmentsFromChapters, techFromInfo } from './mediainfo';
import * as tmdb from './tmdb';
import { fetchCriticScores, OmdbError } from './omdb';
import { runAutoSubtitles } from './autosubs';

const PROBE_CHUNK = 6;
/** How much of each episode's audio is compared when looking for the intro. */
const INTRO_WINDOW_SECONDS = 420;
const SERIES_REFRESH_DAYS = 3;
const COLLECTION_REFRESH_DAYS = 30;
const OMDB_REFRESH_DAYS = 30;
/** Stay well inside OMDb's free 1,000 requests a day. */
const OMDB_PER_RUN = 300;

let running = false;
let again = false;

const status = (message: string) => useLibraryStore.getState().setAnalysis({ running: true, message });

/**
 * Background library analysis, run after scans and at launch:
 *  1. read real stream info (badges, chapters, Dolby Vision) for new/changed files
 *  2. TMDB extras: age ratings, trailers, collections, series status / next episode
 *  3. detect intros from audio for seasons with new episodes
 * Each step only touches what's missing, so repeat runs are cheap.
 */
export async function startBackgroundAnalysis() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await probeFiles();
      await fetchExtras();
      await fetchCollections();
      await fetchCriticRatings();
      if (useLibraryStore.getState().settings.intro_detection) await detectIntros();
      if (useLibraryStore.getState().settings.subtitles_auto) await runAutoSubtitles();
    } while (again);
  } catch (e) {
    console.warn('[analysis]', e);
  } finally {
    running = false;
    useLibraryStore.getState().setAnalysis({ running: false, message: '' });
    await useLibraryStore.getState().reload();
  }
}

// ---------------------------------------------------------------------------

type ProbeTarget = { table: 'movies' | 'episodes'; row: MovieRow | EpisodeRow };

async function probeFiles() {
  const { movies, episodes } = useLibraryStore.getState();
  const incompletePaths = await db.getIncompleteTorrentPaths();
  // Changed files, plus files probed before the truncation check existed (skipping active downloads).
  const stale = (r: MovieRow | EpisodeRow) =>
    !incompletePaths.has(r.file_path) && (r.probed_mtime !== r.file_mtime || (!!r.media_info && !r.media_info.includes('"tail_ok"')));
  const targets: ProbeTarget[] = [
    ...movies.filter(stale).map((row) => ({ table: 'movies' as const, row })),
    ...episodes.filter(stale).map((row) => ({ table: 'episodes' as const, row })),
  ];
  if (!targets.length) return;
  const status0 = await invoke<{ available: boolean }>('player_status').catch(() => ({ available: false }));
  if (!status0.available) return; // the probe uses the bundled player engine

  for (let i = 0; i < targets.length; i += PROBE_CHUNK) {
    const chunk = targets.slice(i, i + PROBE_CHUNK);
    status(`Reading media info · ${Math.min(i + PROBE_CHUNK, targets.length)} of ${targets.length}`);
    const infos = await invoke<(MediaInfo | null)[]>('media_probe', { paths: chunk.map((t) => t.row.file_path) }).catch(() => []);
    for (let k = 0; k < chunk.length; k++) {
      const info = infos[k];
      const { table, row } = chunk[k];
      if (!info) continue; // missing (offline drive): try again later
      if (info.error) {
        await db.markProbeFailed(table, row.id, row.file_mtime, info.error, info.size ?? null);
        continue;
      }
      const existing = parseSegments(row.segments);
      // Markers set by hand always win; audio-detected ones stay unless the chapters now cover them.
      const manual = existing.filter((s) => s.source === 'manual');
      const fromChapters = segmentsFromChapters(info).filter((c) => !manual.some((m) => m.kind === c.kind));
      const audio = existing.filter((s) => s.source === 'audio' && ![...manual, ...fromChapters].some((c) => c.kind === s.kind));
      await db.saveMediaInfo(table, row.id, row.file_mtime, info, techFromInfo(info, row), [...manual, ...fromChapters, ...audio]);
    }
    if ((i / PROBE_CHUNK) % 5 === 4) await useLibraryStore.getState().reload();
  }
  await useLibraryStore.getState().reload();
}

async function fetchExtras() {
  const { movies, series } = useLibraryStore.getState();
  // `stinger` arrived later: movies enriched before it are fetched once more.
  const movieIds = [...new Set(movies.filter((m) => m.tmdb_id && (!m.enriched_at || m.stinger == null)).map((m) => m.tmdb_id!))];
  const stale = (at: string | null) => !at || Date.now() - Date.parse(at.replace(' ', 'T') + 'Z') > SERIES_REFRESH_DAYS * 864e5;
  const shows = series.filter((s) => s.tmdb_id > 0 && (!s.enriched_at || (s.tmdb_status !== 'Ended' && s.tmdb_status !== 'Canceled' && stale(s.enriched_at))));
  const total = movieIds.length + shows.length;
  if (!total) return;
  let done = 0;
  for (const id of movieIds) {
    status(`Fetching ratings & trailers · ${++done} of ${total}`);
    try {
      await db.saveMovieExtras(id, await tmdb.getMovieExtras(id));
    } catch (e) {
      if (e instanceof tmdb.TmdbError && (e.network || e.status === 401)) return;
    }
  }
  for (const s of shows) {
    status(`Fetching ratings & trailers · ${++done} of ${total}`);
    try {
      await db.saveSeriesExtras(s.id, await tmdb.getSeriesExtras(s.tmdb_id));
    } catch (e) {
      if (e instanceof tmdb.TmdbError && (e.network || e.status === 401)) return;
    }
  }
  await useLibraryStore.getState().reload();
}

async function fetchCollections() {
  const { movies } = useLibraryStore.getState();
  const known = new Map((await db.listCollections()).map((c) => [c.id, c]));
  const ids = [...new Set(movies.map((m) => m.collection_id).filter((id): id is number => !!id))].filter((id) => {
    const c = known.get(id);
    return !c?.fetched_at || Date.now() - Date.parse(c.fetched_at.replace(' ', 'T') + 'Z') > COLLECTION_REFRESH_DAYS * 864e5;
  });
  for (const [i, id] of ids.entries()) {
    status(`Fetching collections · ${i + 1} of ${ids.length}`);
    try {
      await db.saveCollection(await tmdb.getCollection(id));
    } catch {
      /* try again next run */
    }
  }
  if (ids.length) await useLibraryStore.getState().reload();
}

export interface CriticRefresh {
  checked: number;
  found: number;
  error: string | null;
}

/** Rotten Tomatoes / Metacritic from OMDb for titles not checked recently (all of them with `force`). */
async function fetchCriticRatings(force = false): Promise<CriticRefresh> {
  const result: CriticRefresh = { checked: 0, found: 0, error: null };
  const { settings, movies, series } = useLibraryStore.getState();
  if (!settings.omdb_api_key) return result;
  const stale = (at: string | null) => force || !at || Date.now() - Date.parse(at.replace(' ', 'T') + 'Z') > OMDB_REFRESH_DAYS * 864e5;
  const todo = new Map<string, 'movies' | 'tv_series'>();
  for (const m of movies) if (m.imdb_id && stale(m.omdb_at)) todo.set(m.imdb_id, 'movies');
  for (const s of series) if (s.imdb_id && stale(s.omdb_at)) todo.set(s.imdb_id, 'tv_series');
  const list = [...todo.entries()].slice(0, OMDB_PER_RUN);
  for (const [i, [imdbId, table]] of list.entries()) {
    status(`Fetching Rotten Tomatoes & Metacritic · ${i + 1} of ${list.length}`);
    try {
      const s = await fetchCriticScores(settings.omdb_api_key, imdbId);
      await db.saveOmdbRatings(table, imdbId, s.rt, s.metacritic);
      result.checked++;
      if (s.rt != null || s.metacritic != null) result.found++;
    } catch (e) {
      if (e instanceof OmdbError && e.kind !== 'other') {
        result.error = e.message; // bad key, daily limit or offline: try again next run
        break;
      }
    }
    if (i % 25 === 24) await useLibraryStore.getState().reload();
  }
  if (list.length) await useLibraryStore.getState().reload();
  return result;
}

/** "Refresh critic scores" in Settings: re-checks every title now. */
export async function refreshCriticScores(): Promise<CriticRefresh> {
  try {
    return await fetchCriticRatings(true);
  } finally {
    if (!running) useLibraryStore.getState().setAnalysis({ running: false, message: '' });
  }
}

async function detectIntros() {
  const { episodesBySeries, series } = useLibraryStore.getState();
  const incompletePaths = await db.getIncompleteTorrentPaths();
  let currentStep = '';
  const unlisten = await listen<{ done: number; total: number }>('intro-progress', ({ payload }) => {
    if (currentStep) status(`${currentStep} · ${payload.done} of ${payload.total}`);
  });
  try {
    for (const show of series) {
      const eps = (episodesBySeries.get(show.id) ?? []).filter((e) => !incompletePaths.has(e.file_path));
      const seasons = new Map<number, EpisodeRow[]>();
      for (const e of eps) seasons.set(e.season_number, [...(seasons.get(e.season_number) ?? []), e]);
      for (const [season, list] of seasons) {
        const hasChapterIntro = (e: EpisodeRow) => parseSegments(e.segments).some((s) => s.kind === 'intro' && s.source === 'chapter');
        const pending = list.filter((e) => e.intro_checked !== 1 && !hasChapterIntro(e));
        if (!pending.length) continue;
        // Each pending episode is compared with its neighbours in the season.
        const include = new Set<number>();
        for (const e of pending) {
          const i = list.indexOf(e);
          for (const j of [i - 1, i, i + 1]) if (list[j]) include.add(j);
        }
        const group = [...include].sort((a, b) => a - b).map((j) => list[j]);
        if (group.length < 2) {
          await db.markIntroChecked(pending.map((e) => e.id));
          continue;
        }
        currentStep = `Detecting intros · ${show.title} S${season}`;
        status(currentStep);
        const found = await invoke<([number, number] | null)[]>('detect_intros', {
          paths: group.map((e) => e.file_path),
          windowSeconds: INTRO_WINDOW_SECONDS,
        }).catch((e) => {
          console.warn('[intro]', e);
          return null;
        });
        if (!found) continue;
        for (const [k, e] of group.entries()) {
          const seg = found[k];
          const existing = parseSegments(e.segments);
          const isPending = pending.includes(e);
          if (existing.some((s) => s.kind === 'intro' && s.source === 'manual')) {
            if (isPending) await db.markIntroChecked([e.id]); // never replace an intro set by hand
          } else if (seg && (isPending || !existing.some((s) => s.kind === 'intro'))) {
            const intro: Segment = { kind: 'intro', start: seg[0], end: seg[1], source: 'audio' };
            await db.saveSegments(e.id, [...existing.filter((s) => s.kind !== 'intro'), intro]);
          } else if (isPending) {
            await db.markIntroChecked([e.id]);
          }
        }
        await useLibraryStore.getState().reload();
      }
    }
  } finally {
    unlisten();
  }
}
