import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EpisodeRow, MovieRow } from '../types/media';
import * as db from './db';
import { allFiles, findMissingSubtitles, type HealthFile } from './health';
import { downloadSubtitle, searchSubtitles, subtitlesEnabled, type SubtitleResult, type SubtitleTarget } from './subtitles';

/** Titles where nothing was found are tried again after this long. */
const RETRY_DAYS = 14;
/** At most this many downloads per run (the daily allowance is usually 5–20). */
const MAX_PER_RUN = 10;

export interface AutoSubsResult {
  downloaded: number;
  synced: number;
  checked: number;
  remaining: number | null;
  message: string;
}

const today = () => new Date().toLocaleDateString('en-CA');
let running = false;

function bestMatch(results: SubtitleResult[]): SubtitleResult | null {
  const usable = results.filter((r) => !r.aiTranslated);
  // Exact release (file hash) first, then the most downloaded, preferring non-SDH.
  return (
    usable.find((r) => r.hashMatch && !r.hearingImpaired) ??
    usable.find((r) => r.hashMatch) ??
    [...usable].sort((a, b) => Number(a.hearingImpaired) - Number(b.hearingImpaired) || b.downloads - a.downloads)[0] ??
    null
  );
}

function targetFor(file: HealthFile, movies: MovieRow[], episodes: EpisodeRow[]): SubtitleTarget | null {
  const { series } = useLibraryStore.getState();
  if (file.kind === 'movie') {
    const m = movies.find((x) => x.id === file.id);
    if (!m) return null;
    return { type: 'movie', id: m.id, filePath: m.file_path, tmdbId: m.tmdb_id, fallbackQuery: m.raw_filename.replace(/\.[^.]+$/, '') };
  }
  const e = episodes.find((x) => x.id === file.id);
  const show = e ? series.find((s) => s.id === e.series_id) : undefined;
  if (!e || !show) return null;
  const code = `S${String(e.season_number).padStart(2, '0')}E${String(e.episode_number).padStart(2, '0')}`;
  return {
    type: 'episode',
    id: e.id,
    filePath: e.file_path,
    parentTmdbId: show.tmdb_id > 0 ? show.tmdb_id : null,
    season: e.season_number,
    episode: e.episode_number,
    fallbackQuery: `${show.title} ${code}`,
  };
}

/**
 * Downloads missing subtitles in the preferred language, within OpenSubtitles' daily allowance.
 * Runs quietly after library analysis; `manual` (Settings › Run now) also runs while something plays.
 */
export async function runAutoSubtitles(manual = false): Promise<AutoSubsResult> {
  const result: AutoSubsResult = { downloaded: 0, synced: 0, checked: 0, remaining: null, message: '' };
  const store = useLibraryStore.getState();
  const { settings } = store;
  if (!settings.subtitles_auto && !manual) return { ...result, message: 'Turned off' };
  if (!subtitlesEnabled(settings)) return { ...result, message: 'Add an OpenSubtitles API key first' };
  if (!manual && store.playerSession) return { ...result, message: 'Waiting until playback stops' };
  if (settings.subtitles_auto_paused === today()) return { ...result, remaining: 0, message: 'Today’s download allowance is used up; continuing tomorrow' };
  if (running) return { ...result, message: 'Already running' };
  running = true;

  try {
    const { movies, series, episodes, episodesBySeries, allItems } = store;
    const language = settings.subtitle_language || 'en';
    const { files, infos } = allFiles(movies, series, episodesBySeries, allItems);
    const missing = await findMissingSubtitles(files, infos, language);
    const recentlyTried = (r: { subs_auto_at: string | null; subs_auto_result: string | null } | undefined) =>
      !!r?.subs_auto_at && r.subs_auto_result === 'none' && Date.now() - Date.parse(r.subs_auto_at.replace(' ', 'T') + 'Z') < RETRY_DAYS * 864e5;
    const rowOf = (f: HealthFile) => (f.kind === 'movie' ? movies.find((m) => m.id === f.id) : episodes.find((e) => e.id === f.id));
    // In-progress titles first, then the most recently added.
    const score = (f: HealthFile) => {
      const r = rowOf(f);
      return (r?.progress_seconds ? 2e12 : 0) + (r?.last_watched_at ? 1e12 : 0) + Date.parse((r && 'created_at' in r ? r.created_at : '') || '0') / 1000;
    };
    const queue = missing.filter((f) => !recentlyTried(rowOf(f))).sort((a, b) => score(b) - score(a));

    for (const file of queue) {
      if (result.downloaded >= MAX_PER_RUN) break;
      if (!manual && useLibraryStore.getState().playerSession) break; // don't compete with playback
      const target = targetFor(file, movies, episodes);
      if (!target) continue;
      const table = file.kind === 'movie' ? 'movies' : 'episodes';
      store.setAnalysis({ running: true, message: `Finding subtitles · ${file.title}${file.kind === 'episode' ? ` ${file.detail.split(' · ')[0]}` : ''}` });
      result.checked++;
      let pick: SubtitleResult | null;
      try {
        pick = bestMatch(await searchSubtitles(useLibraryStore.getState().settings, target, language));
      } catch (e) {
        result.message = `OpenSubtitles search failed: ${String(e)}`;
        break;
      }
      if (!pick) {
        await db.markSubtitleAttempt(table, file.id, 'none');
        continue;
      }
      try {
        const res = await downloadSubtitle(useLibraryStore.getState().settings, target, pick);
        result.downloaded++;
        result.remaining = res.remaining;
        await db.markSubtitleAttempt(table, file.id, 'found');
        // Not the exact release: line it up with the dialogue.
        if (!pick.hashMatch && useLibraryStore.getState().settings.subtitles_auto_sync) {
          store.setAnalysis({ running: true, message: `Syncing subtitles · ${file.title}` });
          const sync = await invoke<{ applied: boolean }>('sync_subtitle', { videoPath: target.filePath, subtitlePath: res.path }).catch(() => null);
          if (sync?.applied) result.synced++;
        }
        if (res.remaining === 0) break;
      } catch (e) {
        const text = String(e);
        if (/allowed|quota|limit|406|429/i.test(text)) {
          result.remaining = 0;
          break;
        }
        result.message = `Download failed: ${text}`;
        break;
      }
    }

    if (result.remaining === 0) await useLibraryStore.getState().updateSettings({ subtitles_auto_paused: today() });
    if (!result.message) {
      result.message = !queue.length
        ? 'Nothing missing'
        : result.downloaded
          ? `Downloaded ${result.downloaded}${result.synced ? ` (${result.synced} retimed to match the dialogue)` : ''}`
          : result.remaining === 0
            ? 'Today’s download allowance is used up; continuing tomorrow'
            : 'No matching subtitles found';
    }
    if (result.downloaded) await useLibraryStore.getState().reload();
    return result;
  } finally {
    running = false;
    useLibraryStore.getState().setAnalysis({ running: false, message: '' });
  }
}
