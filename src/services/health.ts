import { invoke } from '@tauri-apps/api/core';
import type { EpisodeRow, MediaInfo, MediaItem, MovieRow, SeriesRow } from '../types/media';
import { epLabel } from '../store/selectors';
import { parseMediaInfo } from './mediainfo';
import { normalizeLang } from './subtitles';

/** One file, as listed on the health page. */
export interface HealthFile {
  kind: 'movie' | 'episode';
  id: number;
  itemKey: string;
  title: string;
  /** Episode code / version label. */
  detail: string;
  path: string;
  size: number | null;
  episode?: EpisodeRow;
  reason?: string;
}

export interface UsageRow {
  itemKey: string;
  title: string;
  poster: string | null;
  kind: 'movie' | 'tv';
  bytes: number;
  files: number;
}

export interface DuplicateGroup {
  id: string;
  title: string;
  itemKey: string;
  /** Best copy first. */
  files: HealthFile[];
}

export interface HealthReport {
  totalBytes: number;
  fileCount: number;
  analysed: number;
  usage: UsageRow[];
  duplicates: DuplicateGroup[];
  problems: HealthFile[];
  upgrades: HealthFile[];
}

const sizeOf = (r: MovieRow | EpisodeRow, info: MediaInfo | null) => r.file_size ?? info?.size ?? null;

const RES_ORDER: Record<string, number> = { SD: 0, '720p': 1, HD: 2, '4K': 3 };
/** Bitrates below these look like heavily compressed encodes (kbps). */
const LOW_BITRATE: Record<string, number> = { '4K': 8000, HD: 2500, '720p': 1200 };

const mbps = (kbps: number) => `${(kbps / 1000).toFixed(1)} Mb/s`;
const RES_NAME: Record<string, string> = { '4K': '4K', HD: '1080p', '720p': '720p', SD: 'SD' };

function problemOf(r: MovieRow | EpisodeRow, info: MediaInfo | null, expectedMinutes: number | null): string | null {
  if (r.probe_error) return `Can’t be played: ${r.probe_error}`;
  if (!info) return null;
  if (info.tail_ok === false) return 'Incomplete: the end of the file is missing (interrupted download?)';
  if (!info.width) return 'No video stream';
  if (!info.audio.length) return 'No audio track';
  if (expectedMinutes && expectedMinutes >= 20 && info.duration > 0 && info.duration < expectedMinutes * 60 * 0.7) {
    return `Shorter than expected: ${Math.round(info.duration / 60)} of ${expectedMinutes} min`;
  }
  return null;
}

function upgradeOf(r: MovieRow | EpisodeRow, info: MediaInfo | null, size: number | null): string | null {
  const res = r.resolution;
  if (res === 'SD' || res === '720p') return `${RES_NAME[res]} copy`;
  if (info && size && info.duration > 60 && res && LOW_BITRATE[res]) {
    const kbps = (size * 8) / info.duration / 1000;
    if (kbps < LOW_BITRATE[res]) return `Low bitrate for ${RES_NAME[res]} (${mbps(kbps)})`;
  }
  return null;
}

export function buildHealthReport(
  movies: MovieRow[],
  series: SeriesRow[],
  episodesBySeries: Map<number, EpisodeRow[]>,
  items: MediaItem[],
): HealthReport {
  const usage: UsageRow[] = [];
  const duplicates: DuplicateGroup[] = [];
  const problems: HealthFile[] = [];
  const upgrades: HealthFile[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  let analysed = 0;
  const movieById = new Map(movies.map((m) => [m.id, m]));

  for (const item of items) {
    if (item.kind === 'movie') {
      const rows = item.versions.map((v) => movieById.get(v.id)).filter((m): m is MovieRow => !!m);
      let bytes = 0;
      const files: HealthFile[] = [];
      const bestRes = Math.max(...rows.map((r) => RES_ORDER[r.resolution ?? ''] ?? -1));
      for (const r of rows) {
        const info = parseMediaInfo(r.media_info);
        const size = sizeOf(r, info);
        bytes += size ?? 0;
        fileCount++;
        if (info || r.probe_error) analysed++;
        const file: HealthFile = {
          kind: 'movie',
          id: r.id,
          itemKey: item.key,
          title: item.title,
          detail: item.versions.find((v) => v.id === r.id)?.label ?? '',
          path: r.file_path,
          size,
        };
        files.push(file);
        const problem = problemOf(r, info, item.runtime);
        if (problem) problems.push({ ...file, reason: problem });
        // Only suggest upgrading when this is the best copy you have.
        const upgrade = (RES_ORDER[r.resolution ?? ''] ?? -1) >= bestRes ? upgradeOf(r, info, size) : null;
        if (upgrade && !problem) upgrades.push({ ...file, reason: upgrade });
      }
      totalBytes += bytes;
      usage.push({ itemKey: item.key, title: item.year ? `${item.title} (${item.year})` : item.title, poster: item.poster, kind: 'movie', bytes, files: rows.length });
      if (files.length > 1) duplicates.push({ id: item.key, title: item.title, itemKey: item.key, files });
    } else {
      const show = series.find((s) => s.id === item.id);
      const eps = episodesBySeries.get(item.id) ?? [];
      let bytes = 0;
      const bySlot = new Map<string, HealthFile[]>();
      for (const e of eps) {
        const info = parseMediaInfo(e.media_info);
        const size = sizeOf(e, info);
        bytes += size ?? 0;
        fileCount++;
        if (info || e.probe_error) analysed++;
        const file: HealthFile = {
          kind: 'episode',
          id: e.id,
          itemKey: item.key,
          title: show?.title ?? item.title,
          detail: `${epLabel(e)} · ${e.title}`,
          path: e.file_path,
          size,
          episode: e,
        };
        const slot = `${e.season_number}x${e.episode_number}`;
        bySlot.set(slot, [...(bySlot.get(slot) ?? []), file]);
        const problem = problemOf(e, info, e.runtime);
        if (problem) problems.push({ ...file, reason: problem });
        const upgrade = upgradeOf(e, info, size);
        if (upgrade && !problem) upgrades.push({ ...file, reason: upgrade });
      }
      totalBytes += bytes;
      usage.push({ itemKey: item.key, title: item.title, poster: item.poster, kind: 'tv', bytes, files: eps.length });
      for (const [slot, files] of bySlot) {
        if (files.length < 2) continue;
        const rank = (f: HealthFile) => (RES_ORDER[f.episode?.resolution ?? ''] ?? -1) * 1e13 + (f.size ?? 0);
        duplicates.push({ id: `${item.key}-${slot}`, title: `${item.title} · ${files[0].detail.split(' · ')[0]}`, itemKey: item.key, files: [...files].sort((a, b) => rank(b) - rank(a)) });
      }
    }
  }

  usage.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes, fileCount, analysed, usage, duplicates, problems, upgrades };
}

/**
 * Files without subtitles in `language` (embedded tracks or subtitle files next to the video).
 * With no language set, any subtitle counts.
 */
export async function findMissingSubtitles(files: HealthFile[], infos: Map<string, MediaInfo | null>, language: string): Promise<HealthFile[]> {
  const want = normalizeLang(language);
  const sidecars = await invoke<string[][]>('sidecar_subtitle_languages', { videoPaths: files.map((f) => f.path) }).catch(() => files.map(() => []));
  return files.filter((f, i) => {
    const embedded = (infos.get(f.path)?.subs ?? []).filter((s) => !s.forced).map((s) => normalizeLang(s.lang));
    const local = sidecars[i] ?? [];
    if (!want) return embedded.length === 0 && local.length === 0;
    // Sidecars without a language tag are assumed to be in the preferred language.
    return !embedded.includes(want) && !local.some((l) => !l || normalizeLang(l) === want);
  });
}

/** Every playable file in the library (for the subtitle check). */
export function allFiles(movies: MovieRow[], series: SeriesRow[], episodesBySeries: Map<number, EpisodeRow[]>, items: MediaItem[]) {
  const files: HealthFile[] = [];
  const infos = new Map<string, MediaInfo | null>();
  const movieById = new Map(movies.map((m) => [m.id, m]));
  for (const item of items) {
    if (item.kind === 'movie') {
      for (const v of item.versions) {
        const r = movieById.get(v.id);
        if (!r) continue;
        infos.set(r.file_path, parseMediaInfo(r.media_info));
        files.push({ kind: 'movie', id: r.id, itemKey: item.key, title: item.title, detail: v.label, path: r.file_path, size: r.file_size });
      }
    } else {
      const show = series.find((s) => s.id === item.id);
      for (const e of episodesBySeries.get(item.id) ?? []) {
        infos.set(e.file_path, parseMediaInfo(e.media_info));
        files.push({ kind: 'episode', id: e.id, itemKey: item.key, title: show?.title ?? item.title, detail: `${epLabel(e)} · ${e.title}`, path: e.file_path, size: e.file_size, episode: e });
      }
    }
  }
  return { files, infos };
}
