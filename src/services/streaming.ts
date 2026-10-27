import { invoke } from '@tauri-apps/api/core';
import type { EpisodeRow, MediaInfo, MovieRow } from '../types/media';
import { parseMediaInfo } from './mediainfo';

export type StreamClient = 'browser' | 'chromecast' | 'dlna' | 'dlna-compat';

export interface StreamOptions {
  format: 'direct' | 'hls' | 'ts';
  width: number;
  height: number;
  tone_map: boolean;
  aid: number | null;
}

const ext = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';

/** Plays as-is in browsers and on Chromecast: MP4/WebM with H.264/VP9/AV1 and AAC/MP3/Opus, SDR. */
function webCompatible(path: string, info: MediaInfo | null): boolean {
  if (!info) return false;
  const container = ['mp4', 'm4v', 'webm'].includes(ext(path));
  const video = ['h264', 'vp9', 'av1'].includes(info.video_codec ?? '');
  const audio = info.audio.length === 0 || ['aac', 'mp3', 'opus', 'vorbis'].includes(info.audio.find((a) => a.default)?.codec ?? info.audio[0].codec ?? '');
  const sdr = info.gamma !== 'pq' && info.gamma !== 'hlg';
  return container && video && audio && sdr;
}

/** Conversion size: up to 1080p, keeping the aspect ratio (even numbers). */
function outputSize(info: MediaInfo | null): { width: number; height: number } {
  const w = info?.width || 1920;
  const h = info?.height || 1080;
  const scale = Math.min(1, 1920 / w, 1080 / h);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * scale), height: even(h * scale) };
}

/**
 * How a device should get this file: as-is when it can play it, otherwise converted on the fly.
 * Smart TVs (DLNA) usually play the original; `dlna-compat` is the fallback when one refuses.
 */
export function planStream(row: MovieRow | EpisodeRow, client: StreamClient): StreamOptions {
  const info = parseMediaInfo(row.media_info);
  const convert = (format: 'hls' | 'ts'): StreamOptions => ({
    format,
    ...outputSize(info),
    tone_map: info?.gamma === 'pq' || info?.gamma === 'hlg',
    aid: null,
  });
  if (client === 'dlna') return { format: 'direct', width: 0, height: 0, tone_map: false, aid: null };
  if (client === 'dlna-compat') return convert('ts');
  return webCompatible(row.file_path, info) ? { format: 'direct', width: 0, height: 0, tone_map: false, aid: null } : convert('hls');
}

export interface StreamUrl {
  url: string;
  path: string;
  offset: number;
}

export async function registerStream(path: string, options: StreamOptions): Promise<string> {
  return invoke<string>('stream_register', { path, options });
}

export async function streamUrl(token: string, start: number, host?: string | null): Promise<StreamUrl> {
  return invoke<StreamUrl>('stream_url', { token, start, host: host ?? null });
}

export function releaseStream(token: string) {
  void invoke('stream_release', { token }).catch(() => {});
}

export function durationOf(row: MovieRow | EpisodeRow): number {
  return parseMediaInfo(row.media_info)?.duration || row.duration_seconds || (row.runtime ?? 0) * 60;
}
