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
  sid: number | null;
  sub_style: [string, string][];
}

export interface StreamAudioTrack {
  id: number;
  lang: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
  default: boolean;
  selected: boolean;
}

export interface StreamSubTrack {
  id: number;
  lang: string | null;
  title: string | null;
  codec: string | null;
  forced: boolean;
  default: boolean;
  selected: boolean;
  external: boolean;
  external_filename: string | null;
}

export interface StreamChapter {
  title: string;
  time: number;
}

export interface StreamProbe {
  duration: number;
  fps: number;
  audio: StreamAudioTrack[];
  subs: StreamSubTrack[];
  chapters: StreamChapter[];
}

export interface StreamChoice {
  aid?: number | null;
  defaultAid?: number | null;
  sid?: number | null;
  subStyle?: [string, string][];
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
 * Burning in subtitles or switching to a non-default audio track also uses HLS conversion.
 */
export function planStream(row: MovieRow | EpisodeRow, client: StreamClient, choice: StreamChoice = {}): StreamOptions {
  const info = parseMediaInfo(row.media_info);
  const aid = choice.aid && choice.aid > 0 ? choice.aid : null;
  const sid = choice.sid && choice.sid > 0 ? choice.sid : null;
  const sub_style = sid ? (choice.subStyle ?? []) : [];
  const convert = (format: 'hls' | 'ts'): StreamOptions => ({
    format,
    ...outputSize(info),
    tone_map: info?.gamma === 'pq' || info?.gamma === 'hlg',
    aid,
    sid,
    sub_style,
  });
  if (client === 'dlna') return { format: 'direct', width: 0, height: 0, tone_map: false, aid: null, sid: null, sub_style: [] };
  if (client === 'dlna-compat') return convert('ts');
  const needsBurnOrTrack = sid !== null || (aid !== null && choice.defaultAid != null && aid !== choice.defaultAid);
  return !needsBurnOrTrack && webCompatible(row.file_path, info)
    ? { format: 'direct', width: 0, height: 0, tone_map: false, aid: null, sid: null, sub_style: [] }
    : convert('hls');
}

export interface StreamUrl {
  url: string;
  path: string;
  offset: number;
}

export async function probeStream(path: string): Promise<StreamProbe> {
  return invoke<StreamProbe>('stream_probe', { path });
}

export async function detectStreamEncoder(): Promise<string> {
  return invoke<string>('stream_encoder');
}

export function encoderLabel(name: string | null | undefined): string {
  switch (name) {
    case 'h264_videotoolbox':
      return 'Apple VideoToolbox (hardware)';
    case 'h264_nvenc':
      return 'NVIDIA NVENC (hardware)';
    case 'h264_qsv':
      return 'Intel Quick Sync (hardware)';
    case 'h264_amf':
      return 'AMD AMF (hardware)';
    case 'h264_mf':
      return 'Windows Media Foundation';
    case 'h264_vaapi':
      return 'VA-API (hardware)';
    case 'libx264':
      return 'Software (x264)';
    default:
      return name || 'Auto';
  }
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
