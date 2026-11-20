import { filenameParse } from '@ctrl/video-filename-parser';
import type { RawVideoFile, TechInfo } from '../types/media';

export interface ParsedMovieFile {
  kind: 'movie';
  title: string;
  year: number | null;
  tech: TechInfo;
}

export interface ParsedEpisodeFile {
  kind: 'tv';
  showTitle: string;
  year: number | null;
  season: number;
  episodes: number[];
  showFolder: string | null;
  tech: TechInfo;
  /** Daily shows named by date ("2024-03-15"): the episode is looked up by when it aired. */
  airDate?: string;
}

export type ParsedFile = ParsedMovieFile | ParsedEpisodeFile;

// ---------------------------------------------------------------------------
// Regex vocab
// ---------------------------------------------------------------------------

const TV_PATTERNS = [
  /\bS\d{1,2}[ ._-]?E\d{1,4}(?![0-9])/i, // S01E01, S01.E01, S01E01E02
  /(?:^|[^a-z0-9])\d{1,2}x\d{2,3}(?:[^a-z0-9]|$)/i, // 1x01
  /\bSeason[ ._-]*\d{1,2}[ ._-]*Episode[ ._-]*\d{1,3}\b/i, // Season 1 Episode 1
];
const SEASON_FOLDER = /^(?:season|series|staffel|saison|temporada)[ ._-]*(\d{1,4})\b|^S(\d{1,2})$/i;
/** A daily show's air date in the name: "The Daily Show - 2024-03-15", "Last.Week.Tonight.2024.03.17". */
const AIR_DATE = /(?:^|[ ._-])((?:19|20)\d{2})[-. ](0[1-9]|1[0-2])[-. ](0[1-9]|[12]\d|3[01])(?=$|[ ._-])/;
/** Sonarr's and Plex's folder for season 0. */
const SPECIALS_FOLDER = /^specials?$/i;
/** "S01E01", "S01E01E02", "S01E01-E03", "s01.e01": read directly when the parser library gives up. */
const SXXEYY = /\bS(\d{1,2})[ ._-]?E(\d{1,4})((?:[ ._-]?-?[ ._-]?E\d{1,4}|-\d{1,4}(?![0-9p]))*)/i;
const NXNN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:[^a-z0-9]|$)/i;
/** Anime releases: "[Group] Title - 1085 (1080p) [hash]", numbered from the first episode. */
const ANIME_RELEASE = /^\[[^\]]+\][ ._]*(.+?)[ ._]+-[ ._]+(\d{1,4})(?:v\d)?(?=[ ._\[(]|$)/i;
/** "Title - 05": an episode number after a dash (a show inside its season folder). */
const DASH_NUMBER = /[ ._]-[ ._]+(\d{1,4})(?:v\d)?(?=[ ._\[(]|$)/;
const VIDEO_EXT = /\.(?:mkv|mp4|m4v|avi|mov|webm|ts)$/i;
const EPISODE_ONLY = /(?:^|[^a-z0-9])(?:e|ep|episode)[ ._-]*(\d{1,3})(?:[^0-9]|$)/i;
const LEADING_NUMBER = /^(\d{1,3})(?:[ ._-]|$)/;

/** Generic container folders that never carry a title. */
const GENERIC_FOLDERS = new Set(
  [
    'movies', 'movie', 'films', 'film', 'tv', 'tv shows', 'tvshows', 'shows', 'series', 'downloads', 'download',
    'complete', 'completed', 'video', 'videos', 'media', 'plex', 'jellyfin', 'emby', 'library', '4k', 'uhd',
    'hd', 'new', 'torrents', 'volumes', 'users', 'desktop', 'documents', 'home', 'public', 'share', 'nas',
  ].map((s) => s.toLowerCase()),
);

const JUNK_TOKENS = new RegExp(
  [
    '\\b(?:2160p|1080p|1080i|720p|576p|480p|4k|uhd|8k)\\b',
    '\\b(?:blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|web-?rip|webrip|hdtv|dvdrip|dvd|hdrip|amzn|nf|dsnp|hmax|atvp|hulu|pcok)\\b',
    '\\b(?:x\\.?26[45]|h\\.?26[45]|hevc|avc|av1|xvid|divx|10-?bit|8-?bit)\\b',
    '\\b(?:hdr10\\+?|hdr|dv|dovi|dolby[ .]?vision|sdr|hlg)\\b',
    '\\b(?:aac(?:2\\.0)?|ac3|eac3|ddp?(?:5\\.1|7\\.1|2\\.0)?|dts(?:-?hd)?(?:[ .-]?ma)?|truehd|atmos|flac|opus|mp3|lpcm)\\b',
    '\\b(?:[257]\\.[01])\\b',
    '\\b(?:proper|repack|extended|unrated|remastered|directors[ .]?cut|imax|internal|limited|multi|dubbed|subbed)\\b',
  ].join('|'),
  'gi',
);

const toInt = (s: string | null | undefined) => {
  const n = s ? parseInt(s, 10) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Final cosmetic cleanup applied to any extracted title. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\.[a-z0-9]{2,4}$/i, (ext) => (/^\.(mkv|mp4|m4v|avi|mov|webm|ts)$/i.test(ext) ? '' : ext))
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    // Parentheses are noise, except a year and a country ("The Office (US)" and "(UK)" are
    // different shows).
    .replace(/\((?![12]\d{3}\)|(?:US|UK|AU|CA|NZ|IE)\))[^)]*\)/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(JUNK_TOKENS, ' ')
    .replace(/\s-\s*[A-Za-z0-9]+$/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:]+|[\s\-–:]+$/g, '')
    .trim();
}

/** Strips a trailing "(2024)" from a cleaned title (bare numbers like "2049" are kept). */
function splitYear(title: string): { title: string; year: number | null } {
  const m = title.match(/^(.*?)\s*\(((?:19|20)\d{2})\)$/);
  if (m && m[1].trim().length > 0) return { title: m[1].trim(), year: toInt(m[2]) };
  return { title, year: null };
}

function parseName(name: string, isTv: boolean): { title: string; year: number | null } {
  if (!name) return { title: '', year: null };
  const parsed = filenameParse(name, isTv);
  const libYear = toInt(parsed.year);
  const title = cleanTitle(parsed.title || '');
  if (libYear != null) return { title, year: libYear };
  const split = splitYear(title);
  if (split.year == null && isTv) {
    // Scene TV names put the year inline: "Shogun.2024.S01E05".
    const m = title.match(/^(.+?)\s+((?:19|20)\d{2})$/);
    if (m) return { title: m[1], year: toInt(m[2]) };
  }
  return split;
}

/** Folder names ("Severance (2022)", "Shogun.2024.S01.1080p.WEB-DL") parse best as movie-style names. */
function parseFolderName(name: string): { title: string; year: number | null } {
  const cut = name.split(/[ ._-](?:S\d{1,2}(?=[ ._-]|E\d|$)|Season[ ._-]?\d)/i)[0];
  return parseName(cut || name, false);
}

/** Heuristic: scene-obfuscated names such as "d-dune2" or "xyz-mtrx". */
function looksObfuscated(title: string): boolean {
  if (!title) return true;
  const t = title.trim();
  if (t.length <= 2) return true;
  if (/^[a-z0-9]{1,5}-/i.test(t)) return true;
  if (/-$/.test(t)) return true;
  if (!/\s/.test(t) && /[a-z]\d|\d[a-z]/i.test(t) && t === t.toLowerCase()) return true;
  return false;
}

function isGenericFolder(name: string): boolean {
  const n = name.trim().toLowerCase();
  return !n || GENERIC_FOLDERS.has(n) || /^[a-z]:\\?$/i.test(n);
}

function isGenericEpisodeTitle(title: string): boolean {
  const t = title.trim();
  return !t || t.length < 2 || /^(?:s\d+|season|episode|ep|e\d+|\d+)$/i.test(t);
}

// ---------------------------------------------------------------------------
// Technical badges
// ---------------------------------------------------------------------------

export function extractTech(filename: string): TechInfo {
  const f = filename.replace(/_/g, '.');

  let resolution: string | null = null;
  if (/\b(?:2160p|4k|uhd)\b/i.test(f)) resolution = '4K';
  else if (/\b1080[pi]\b/i.test(f)) resolution = 'HD';
  else if (/\b720p\b/i.test(f)) resolution = '720p';

  let hdr_format: string | null = null;
  if (/\b(?:DV|DoVi)\b|Dolby[ .-]?Vision/i.test(f)) hdr_format = 'Dolby Vision';
  else if (/\bHDR10(?:\+|Plus)/i.test(f)) hdr_format = 'HDR10+';
  else if (/\bHDR10\b/i.test(f)) hdr_format = 'HDR10';
  else if (/\bHDR\b/i.test(f)) hdr_format = 'HDR';

  let video_codec: string | null = null;
  if (/\b(?:x\.?265|h\.?265|hevc)\b/i.test(f)) video_codec = 'HEVC';
  else if (/\bav1\b/i.test(f)) video_codec = 'AV1';
  else if (/\b(?:x\.?264|h\.?264|avc)\b/i.test(f)) video_codec = 'H.264';

  const audio: string[] = [];
  if (/\batmos\b/i.test(f)) audio.push('Atmos');
  else if (/\b(?:truehd|dts-?hd|dts[ .-]?ma|dts[ .-]?x)\b/i.test(f)) audio.push('Lossless Audio');
  if (/(?:^|[^0-9])[57]\.1(?:[^0-9]|$)/.test(f)) audio.push('5.1');

  return { resolution, hdr_format, video_codec, audio_codec: audio.length ? audio.join(', ') : null };
}

// ---------------------------------------------------------------------------
// Classification & title extraction
// ---------------------------------------------------------------------------

function seasonFromFolder(name: string): number | null {
  if (SPECIALS_FOLDER.test(name.trim())) return 0;
  const m = name.trim().match(SEASON_FOLDER);
  if (!m) return null;
  return toInt(m[1] ?? m[2]);
}

function isTvFile(file: RawVideoFile): boolean {
  if (TV_PATTERNS.some((re) => re.test(file.filename)) || ANIME_RELEASE.test(file.filename)) return true;
  // A dated name with a title before the date ("Show - 2024-03-15"), not a bare date.
  const dated = file.filename.match(AIR_DATE);
  if (dated && dated.index != null && dated.index > 1) return true;
  return seasonFromFolder(file.parent_folder_name) !== null;
}

function parseEpisode(file: RawVideoFile): ParsedEpisodeFile | null {
  // Without the extension: the parser library returns nothing for "Show - S01E01.mkv" (it does
  // for .mp4), which used to import whole shows as one wrong movie.
  const stem = file.filename.replace(VIDEO_EXT, '');
  const parsed = filenameParse(stem, true);
  const folderSeason = seasonFromFolder(file.parent_folder_name);
  const explicitPattern = TV_PATTERNS.some((re) => re.test(file.filename));
  const anime = stem.match(ANIME_RELEASE);

  let season: number | null = null;
  let episodes: number[] = [];
  if (explicitPattern && 'isTv' in parsed && parsed.isTv) {
    season = parsed.seasons?.[0] ?? null;
    episodes = parsed.episodeNumbers ?? [];
  }
  if (!episodes.length && explicitPattern) {
    const sxe = stem.match(SXXEYY);
    const nx = stem.match(NXNN);
    if (sxe) {
      season = toInt(sxe[1]);
      const first = parseInt(sxe[2], 10);
      const more = [...(sxe[3] ?? '').matchAll(/\d{1,4}/g)].map((m) => parseInt(m[0], 10));
      // "E01-E03" / "E01-03" is a range; "E01E02" a list.
      const ranged = /-/.test(sxe[3] ?? '') && more.length === 1 && more[0] > first && more[0] - first < 10;
      episodes = ranged ? Array.from({ length: more[0] - first + 1 }, (_, i) => first + i) : [first, ...more];
    } else if (nx) {
      season = toInt(nx[1]);
      episodes = [parseInt(nx[2], 10)];
    }
  }
  // A daily show: found by its air date once the show is known; until then it's numbered by date
  // within the year (it used to become a movie per episode).
  const dated = !explicitPattern && !anime ? stem.match(AIR_DATE) : null;
  let airDate: string | undefined;
  if (dated && dated.index != null && dated.index > 1) {
    airDate = `${dated[1]}-${dated[2]}-${dated[3]}`;
    season = folderSeason ?? parseInt(dated[1], 10);
    episodes = [parseInt(dated[2], 10) * 100 + parseInt(dated[3], 10)];
  }
  if (!episodes.length) {
    // No season marker: an absolute or plain episode number ("[Group] Show - 1085", "Show - 05",
    // "E05", "05 - Title"). The parser library would read "1085" as S10E85.
    const m = anime ?? stem.match(DASH_NUMBER) ?? stem.match(EPISODE_ONLY) ?? stem.match(LEADING_NUMBER);
    if (m) episodes = [parseInt(m[anime ? 2 : 1], 10)];
  }
  // Inside a season folder, the parser library still knows older forms ("show.105", "Part 2",
  // "1of11"); the season comes from the folder.
  if (!episodes.length && folderSeason !== null && 'isTv' in parsed && parsed.isTv && parsed.episodeNumbers?.length) {
    episodes = parsed.episodeNumbers;
  }
  if (season == null) season = folderSeason;
  if (season == null && episodes.length) season = 1;
  if (season == null || !episodes.length) return null;

  // Show title: filename first, then folder context.
  let { title, year } = explicitPattern
    ? parseName(stem, true)
    : anime
      ? parseName(anime[1], true)
      : airDate && dated?.index
        ? { title: cleanTitle(stem.slice(0, dated.index)), year: null as number | null }
        : { title: '', year: null as number | null };
  const inSeasonFolder = folderSeason !== null;
  const showFolderName = inSeasonFolder ? file.grandparent_folder_name : file.parent_folder_name;
  const folderInfo = !isGenericFolder(showFolderName) ? parseFolderName(showFolderName) : { title: '', year: null };
  // A show named with a number ("24", "1923") is fine as the folder above a season folder.
  const numericShow = (t: string) => inSeasonFolder && /^\d{2,4}$/.test(t.trim());
  const folderTitleOk = (!isGenericEpisodeTitle(folderInfo.title) || numericShow(folderInfo.title)) && seasonFromFolder(folderInfo.title) === null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // "1923.S01E01": the parser library takes the title for a year.
  if (!title && year != null && folderTitleOk && norm(folderInfo.title) === String(year)) {
    title = folderInfo.title;
    year = null;
  }
  if (folderTitleOk && numericShow(folderInfo.title) && norm(title) === norm(folderInfo.title)) {
    title = folderInfo.title;
    if (year != null && String(year) === norm(title)) year = null;
  } else if ((isGenericEpisodeTitle(title) || looksObfuscated(title)) && folderTitleOk) {
    title = folderInfo.title;
    year = folderInfo.year ?? year;
  } else if (folderTitleOk && year == null && folderInfo.year != null) {
    if (norm(folderInfo.title) === norm(title)) year = folderInfo.year;
  }
  if (isGenericEpisodeTitle(title) && !(folderTitleOk && title === folderInfo.title)) return null;
  if (year != null && String(year) === norm(title)) year = null;

  return {
    kind: 'tv',
    showTitle: title,
    year,
    season,
    episodes: [...new Set(episodes)].sort((a, b) => a - b),
    showFolder: folderTitleOk ? showFolderName : null,
    tech: extractTech(file.filename),
    ...(airDate ? { airDate } : {}),
  };
}

function parseMovie(file: RawVideoFile): ParsedMovieFile {
  const fromFile = parseName(file.filename, false);
  const parent = file.parent_folder_name;
  const fromFolder = !isGenericFolder(parent) ? parseFolderName(parent) : { title: '', year: null };

  let { title, year } = fromFile;
  const folderUsable = fromFolder.title.length > 1 && !looksObfuscated(fromFolder.title);
  if (folderUsable) {
    const preferFolder =
      looksObfuscated(fromFile.title) ||
      (fromFolder.year != null && fromFile.year == null) ||
      (fromFolder.year != null && fromFolder.year === fromFile.year && fromFolder.title.length > fromFile.title.length + 3);
    if (preferFolder) {
      title = fromFolder.title;
      year = fromFolder.year ?? fromFile.year;
    }
  }
  if (!title) title = cleanTitle(file.filename) || file.filename;

  return { kind: 'movie', title, year, tech: extractTech(file.filename) };
}

/** Classifies a scanned file as a movie or episode and extracts a clean, searchable title. */
export function parseVideoFile(file: RawVideoFile): ParsedFile {
  if (isTvFile(file)) {
    const ep = parseEpisode(file);
    if (ep) return ep;
  }
  return parseMovie(file);
}

/** Best-effort season/episode guess (used when Fix Match converts a movie into an episode). */
export function guessSeasonEpisode(file: RawVideoFile): { season: number; episode: number } {
  const ep = parseEpisode(file);
  return { season: ep?.season ?? 1, episode: ep?.episodes[0] ?? 1 };
}

export function toRawFile(filePath: string, mtime: number): RawVideoFile {
  const parts = filePath.split(/[\\/]/);
  return {
    file_path: filePath,
    filename: parts[parts.length - 1] ?? filePath,
    parent_folder_name: parts[parts.length - 2] ?? '',
    grandparent_folder_name: parts[parts.length - 3] ?? '',
    file_size: 0,
    mtime,
  };
}
