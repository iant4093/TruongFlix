import { invoke } from '@tauri-apps/api/core';
import type { EpisodeRow, MediaInfo, MovieRow } from '../types/media';
import { parseMediaInfo } from './mediainfo';
import { BITRATES, DEFAULT_CONVERTED, PEAK_FACTOR, QUALITY_STEPS, type Quality, type QualityStep } from '../lib/quality';

export type StreamClient = 'browser' | 'chromecast' | 'dlna' | 'dlna-compat';

export interface StreamOptions {
  /** 'mp4': one progressive MP4 for saving offline. */
  format: 'direct' | 'hls' | 'ts' | 'mp4';
  width: number;
  height: number;
  tone_map: boolean;
  aid: number | null;
  sid: number | null;
  sub_style: [string, string][];
  /** Video bitrate in kbit/s (omitted or 0: the encoder's default quality). */
  bitrate?: number;
  /** Peak video bitrate in kbit/s. */
  maxrate?: number;
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
  /** Browser only: the picked quality (checked against the source with `resolveQuality`). */
  quality?: Partial<Quality>;
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

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const DIRECT: StreamOptions = { format: 'direct', width: 0, height: 0, tone_map: false, aid: null, sid: null, sub_style: [] };
/** Files without measured size are treated as 1080p, as before. */
const ASSUMED_LINES = 1080;

/** The source's height as if it were 16:9, so a 3840×1600 film counts as 4K. Null when unknown. */
function sourceLines(info: MediaInfo | null): number | null {
  return info?.width && info?.height ? Math.max(info.height, (info.width * 9) / 16) : null;
}

/** Size for a picture `lines` tall at 16:9, keeping the aspect ratio and never enlarging (even numbers). */
function sizeFor(info: MediaInfo | null, lines: number): { width: number; height: number } {
  const w = info?.width || 1920;
  const h = info?.height || 1080;
  const scale = Math.min(1, lines / (sourceLines(info) ?? ASSUMED_LINES));
  return { width: even(w * scale), height: even(h * scale) };
}

/** Resolution steps at or below the source, highest first (with slack for slightly cropped encodes). */
export function qualitySteps(info: MediaInfo | null): QualityStep[] {
  const lines = sourceLines(info) ?? ASSUMED_LINES;
  return QUALITY_STEPS.filter((s) => Number(s) * 0.95 <= lines);
}

export interface QualityChoices {
  /** "Original" sends the file as it is; false means it is converted at its own resolution. */
  asIs: boolean;
  steps: QualityStep[];
  default: Quality;
}

/** What the browser may pick for this file. `needsConversion`: burned-in subtitles or another audio track. */
export function qualityChoices(row: MovieRow | EpisodeRow, needsConversion = false): QualityChoices {
  const info = parseMediaInfo(row.media_info);
  const asIs = !needsConversion && webCompatible(row.file_path, info);
  const steps = qualitySteps(info);
  const original: Quality = { res: 'original', level: 'high' };
  const fallback: Quality = steps.includes('1080') ? DEFAULT_CONVERTED : steps.length ? { res: steps[0], level: 'high' } : original;
  return { asIs, steps, default: asIs ? original : fallback };
}

/** The quality to use: the request if the source has it, else the next step down, else the default. */
export function resolveQuality(requested: Partial<Quality> | undefined, choices: QualityChoices): Quality {
  const res = requested?.res;
  if (!res || !(res === 'original' || QUALITY_STEPS.includes(res))) return choices.default;
  if (res === 'original') return { res, level: 'high' };
  const level = requested?.level && ['low', 'medium', 'high'].includes(requested.level) ? requested.level : 'high';
  const step = choices.steps.find((s) => Number(s) <= Number(res));
  return step ? { res: step, level } : { res: 'original', level: 'high' };
}

const peak = (kbps: number) => Math.round(kbps * PEAK_FACTOR);

/** Conversion size and bitrate for a quality. "Original" keeps the source size (up to 4K) at the highest bitrate. */
function conversionFor(info: MediaInfo | null, q: Quality): { width: number; height: number; bitrate: number; maxrate: number } {
  if (q.res === 'original') {
    const tier = qualitySteps(info)[0] ?? '480';
    const bitrate = BITRATES[tier].high;
    const size = sourceLines(info) ? sizeFor(info, 2160) : { width: 0, height: 0 };
    return { ...size, bitrate, maxrate: peak(bitrate) };
  }
  const bitrate = BITRATES[q.res][q.level];
  return { ...sizeFor(info, Number(q.res)), bitrate, maxrate: peak(bitrate) };
}

const isHdr = (info: MediaInfo | null) => info?.gamma === 'pq' || info?.gamma === 'hlg';

/**
 * How a device should get this file: as-is when it can play it, otherwise converted on the fly.
 * Burning in subtitles or switching to a non-default audio track also uses HLS conversion.
 * Browsers pass a `quality`: never above the source, and "Original" only plays as-is when it can.
 */
export function planStream(row: MovieRow | EpisodeRow, client: StreamClient, choice: StreamChoice = {}): StreamOptions {
  const info = parseMediaInfo(row.media_info);
  const aid = choice.aid && choice.aid > 0 ? choice.aid : null;
  const sid = choice.sid && choice.sid > 0 ? choice.sid : null;
  const sub_style = sid ? (choice.subStyle ?? []) : [];
  const convert = (format: 'hls' | 'ts'): StreamOptions => ({
    format,
    ...sizeFor(info, 1080),
    tone_map: isHdr(info),
    aid,
    sid,
    sub_style,
  });
  if (client === 'dlna') return { ...DIRECT };
  if (client === 'dlna-compat') return convert('ts');
  const needsBurnOrTrack = sid !== null || (aid !== null && choice.defaultAid != null && aid !== choice.defaultAid);
  if (client === 'browser' && choice.quality) {
    const choices = qualityChoices(row, needsBurnOrTrack);
    const q = resolveQuality(choice.quality, choices);
    if (q.res === 'original' && choices.asIs) return { ...DIRECT };
    return { format: 'hls', ...conversionFor(info, q), tone_map: isHdr(info), aid, sid, sub_style };
  }
  return !needsBurnOrTrack && webCompatible(row.file_path, info) ? { ...DIRECT } : convert('hls');
}

/** Saving offline: the file itself when browsers play it as it is, otherwise one MP4 converted on the PC. */
export function planDownload(row: MovieRow | EpisodeRow, requested?: Partial<Quality>): { options: StreamOptions; quality: Quality } {
  const info = parseMediaInfo(row.media_info);
  const choices = qualityChoices(row);
  const quality = resolveQuality(requested, choices);
  if (quality.res === 'original' && choices.asIs) return { options: { ...DIRECT }, quality };
  return { options: { format: 'mp4', ...conversionFor(info, quality), tone_map: isHdr(info), aid: null, sid: null, sub_style: [] }, quality };
}

/** Video bitrate (kbit/s) a conversion at `q` aims for. */
export function conversionKbps(row: MovieRow | EpisodeRow, q: Quality): number {
  return conversionFor(parseMediaInfo(row.media_info), q).bitrate;
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

export interface DownloadStatus {
  state: 'converting' | 'ready' | 'failed';
  progress: number;
  size: number;
  error: string | null;
}

/** How far a download MP4 (`format: 'mp4'`) has been converted. */
export async function downloadStatus(token: string): Promise<DownloadStatus> {
  return invoke<DownloadStatus>('stream_download_status', { token });
}

export function releaseStream(token: string) {
  void invoke('stream_release', { token }).catch(() => {});
}

export function durationOf(row: MovieRow | EpisodeRow): number {
  return parseMediaInfo(row.media_info)?.duration || row.duration_seconds || (row.runtime ?? 0) * 60;
}
