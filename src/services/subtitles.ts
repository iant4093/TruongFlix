import { invoke } from '@tauri-apps/api/core';
import type { PlayableType, Settings, SubtitleRow } from '../types/media';
import * as db from './db';

/** OpenSubtitles language codes offered in the UI. */
export const SUBTITLE_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt-pt', name: 'Portuguese' },
  { code: 'pt-br', name: 'Portuguese (Brazil)' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'pl', name: 'Polish' },
  { code: 'cs', name: 'Czech' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'ro', name: 'Romanian' },
  { code: 'el', name: 'Greek' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh-cn', name: 'Chinese (Simplified)' },
  { code: 'zh-tw', name: 'Chinese (Traditional)' },
];

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt-pt', pob: 'pt-br',
  dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', cze: 'cs', ces: 'cs', hun: 'hu',
  rum: 'ro', ron: 'ro', gre: 'el', ell: 'el', tur: 'tr', rus: 'ru', ukr: 'uk', ara: 'ar', heb: 'he', hin: 'hi',
  tha: 'th', vie: 'vi', ind: 'id', jpn: 'ja', kor: 'ko', chi: 'zh-cn', zho: 'zh-cn', pt: 'pt-pt', zh: 'zh-cn',
};

/** ISO 639-1/-2 codes and aliases to our subtitle language codes ("eng" → "en"). */
export const normalizeLang = (code: string | null | undefined) => {
  const c = (code ?? '').toLowerCase();
  return LANGUAGE_ALIASES[c] ?? c;
};

export function languageName(code: string | null | undefined): string {
  if (!code) return 'Unknown language';
  const c = code.toLowerCase();
  const norm = LANGUAGE_ALIASES[c] ?? c;
  return SUBTITLE_LANGUAGES.find((l) => l.code === norm)?.name ?? code.toUpperCase();
}

export const subtitlesEnabled = (settings: Settings) => settings.opensubtitles_api_key.trim().length > 0;

/** What we know about the file whose subtitles we're looking for. */
export interface SubtitleTarget {
  type: PlayableType;
  id: number;
  filePath: string;
  /** Movies: the movie's TMDB id. */
  tmdbId?: number | null;
  /** Episodes: the series' TMDB id plus season/episode numbers. */
  parentTmdbId?: number | null;
  season?: number;
  episode?: number;
  fallbackQuery: string;
}

export interface SubtitleResult {
  fileId: number;
  language: string;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  hashMatch: boolean;
  trusted: boolean;
  aiTranslated: boolean;
  uploader: string | null;
}

interface ApiSubtitle {
  attributes: {
    language?: string;
    release?: string;
    download_count?: number;
    hearing_impaired?: boolean;
    moviehash_match?: boolean;
    from_trusted?: boolean;
    ai_translated?: boolean;
    machine_translated?: boolean;
    uploader?: { name?: string };
    files?: { file_id: number; file_name?: string }[];
  };
}

function credentials(settings: Settings) {
  return {
    apiKey: settings.opensubtitles_api_key.trim(),
    username: settings.opensubtitles_username.trim() || null,
    password: settings.opensubtitles_password || null,
  };
}

export async function verifyOpenSubtitles(apiKey: string, username?: string, password?: string) {
  return invoke<{ logged_in: boolean; allowed_downloads: number | null }>('opensubtitles_verify', {
    apiKey: apiKey.trim(),
    username: username?.trim() || null,
    password: password || null,
  });
}

/**
 * Searches OpenSubtitles using the file's moviehash (exact-release, perfectly synced matches)
 * plus the TMDB ids, falling back to a text query for unmatched files.
 */
export async function searchSubtitles(settings: Settings, target: SubtitleTarget, language: string): Promise<SubtitleResult[]> {
  const params: Record<string, string> = { languages: language };
  try {
    params.moviehash = await invoke<string>('subtitle_hash', { videoPath: target.filePath });
  } catch {
    /* tiny or unreadable file: search without the hash */
  }
  if (target.type === 'episode' && target.parentTmdbId) {
    params.parent_tmdb_id = String(target.parentTmdbId);
    if (target.season != null) params.season_number = String(target.season);
    if (target.episode != null) params.episode_number = String(target.episode);
  } else if (target.type === 'movie' && target.tmdbId) {
    params.tmdb_id = String(target.tmdbId);
  } else {
    params.query = target.fallbackQuery;
  }

  const res = await invoke<{ data?: ApiSubtitle[] }>('opensubtitles_search', { apiKey: credentials(settings).apiKey, params });
  return (res.data ?? [])
    .filter((d) => d.attributes.files?.length && !d.attributes.machine_translated)
    .map((d) => {
      const a = d.attributes;
      return {
        fileId: a.files![0].file_id,
        language: a.language ?? language,
        release: a.release || a.files![0].file_name || 'Unnamed release',
        downloads: a.download_count ?? 0,
        hearingImpaired: !!a.hearing_impaired,
        hashMatch: !!a.moviehash_match,
        trusted: !!a.from_trusted,
        aiTranslated: !!a.ai_translated,
        uploader: a.uploader?.name ?? null,
      };
    })
    .sort((a, b) => Number(b.hashMatch) - Number(a.hashMatch) || b.downloads - a.downloads)
    .slice(0, 15);
}

/** Downloads a subtitle beside the video, records it, and makes it the active subtitle. */
export async function downloadSubtitle(settings: Settings, target: SubtitleTarget, result: SubtitleResult) {
  const { apiKey, username, password } = credentials(settings);
  const res = await invoke<{ path: string; remaining: number | null; message: string | null }>('opensubtitles_download', {
    apiKey,
    username,
    password,
    fileId: result.fileId,
    videoPath: target.filePath,
    language: result.language,
  });
  const rowId = await db.addSubtitle(target.type, target.id, {
    language: result.language,
    file_path: res.path,
    source: 'opensubtitles',
    release_name: result.release,
    hash_match: result.hashMatch,
    opensubtitles_file_id: result.fileId,
  });
  await db.selectSubtitle(target.type, target.id, rowId);
  return res;
}

export interface LocalSubtitle {
  path: string;
  file_name: string;
  language: string | null;
}

export function listLocalSubtitles(filePath: string) {
  return invoke<LocalSubtitle[]>('list_local_subtitles', { videoPath: filePath });
}

/** Selects a subtitle file that already sits next to the video. */
export async function selectLocalSubtitle(target: SubtitleTarget, local: LocalSubtitle) {
  const rowId = await db.addSubtitle(target.type, target.id, {
    language: LANGUAGE_ALIASES[local.language ?? ''] ?? local.language ?? 'und',
    file_path: local.path,
    source: 'local',
    release_name: local.file_name,
    hash_match: false,
    opensubtitles_file_id: null,
  });
  await db.selectSubtitle(target.type, target.id, rowId);
}

/** Forgets a subtitle; files TruongFlix downloaded are deleted, the user's own files are kept. */
export async function removeSubtitle(row: SubtitleRow) {
  if (row.source === 'opensubtitles') await invoke('delete_subtitle_file', { path: row.file_path });
  await db.deleteSubtitle(row.id);
}
