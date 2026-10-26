import type { MediaInfo, Segment, TechInfo } from '../types/media';

export function parseMediaInfo(json: string | null | undefined): MediaInfo | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as MediaInfo;
  } catch {
    return null;
  }
}

export function parseSegments(json: string | null | undefined): Segment[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as Segment[];
  } catch {
    return [];
  }
}

const VIDEO_CODECS: Record<string, string> = { hevc: 'HEVC', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', vc1: 'VC-1' };

export function resolutionLabel(width: number, height: number): string | null {
  if (!width || !height) return null;
  if (width >= 3200 || height >= 1900) return '4K';
  if (width >= 1800 || height >= 1000) return 'HD';
  if (width >= 1200 || height >= 700) return '720p';
  return 'SD';
}

function mainAudio(info: MediaInfo) {
  return info.audio.find((a) => a.default) ?? info.audio[0] ?? null;
}

/** Quality badges from the real streams (more reliable than the file name). */
export function techFromInfo(info: MediaInfo, fallback: TechInfo): TechInfo {
  const audio = mainAudio(info);
  const desc = `${audio?.profile ?? ''} ${audio?.title ?? ''}`;
  const tags: string[] = [];
  if (/atmos/i.test(desc)) tags.push('Atmos');
  else if (audio && (audio.codec === 'truehd' || audio.codec === 'flac' || audio.codec?.startsWith('pcm') || /DTS-HD MA|DTS:X/i.test(desc))) {
    tags.push('Lossless Audio');
  }
  const ch = audio?.channels ?? 0;
  if (ch >= 8) tags.push('7.1');
  else if (ch >= 6) tags.push('5.1');

  let hdr: string | null = null;
  if (info.dv_profile != null) hdr = 'Dolby Vision';
  else if (info.gamma === 'pq') hdr = fallback.hdr_format === 'HDR10+' ? 'HDR10+' : 'HDR10';
  else if (info.gamma === 'hlg') hdr = 'HLG';

  return {
    resolution: resolutionLabel(info.width, info.height) ?? fallback.resolution,
    video_codec: (info.video_codec && VIDEO_CODECS[info.video_codec]) ?? info.video_codec?.toUpperCase() ?? fallback.video_codec,
    hdr_format: hdr,
    audio_codec: tags.length ? tags.join(', ') : audio ? null : fallback.audio_codec,
  };
}

const INTRO_RE = /\b(intro|opening|op|theme|main title|title sequence|opening credits)\b/i;
const RECAP_RE = /\b(recap|previously|last time)\b/i;
const CREDITS_RE = /\b(credits|ending|end credits|outro|ed|closing)\b/i;

/** Intro/recap/credits segments from chapter titles (e.g. "Opening", "Previously On", "End Credits"). */
export function segmentsFromChapters(info: MediaInfo): Segment[] {
  const out: Segment[] = [];
  const ch = info.chapters;
  for (let i = 0; i < ch.length; i++) {
    const end = ch[i + 1]?.time ?? info.duration;
    const title = ch[i].title ?? '';
    const kind = RECAP_RE.test(title) ? 'recap' : CREDITS_RE.test(title) && !/opening/i.test(title) ? 'credits' : INTRO_RE.test(title) ? 'intro' : null;
    if (!kind || end - ch[i].time < 5) continue;
    // Credits only count near the end; intros/recaps only near the start.
    if (kind === 'credits' && ch[i].time < info.duration * 0.6) continue;
    if (kind !== 'credits' && ch[i].time > Math.min(900, info.duration * 0.4)) continue;
    if (out.some((s) => s.kind === kind)) continue;
    out.push({ kind, start: ch[i].time, end, source: 'chapter' });
  }
  return out;
}

const AUDIO_NAMES: Record<string, string> = {
  truehd: 'TrueHD',
  eac3: 'Dolby Digital+',
  ac3: 'Dolby Digital',
  dts: 'DTS',
  aac: 'AAC',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
};

/** Human-readable lines for the "Video / Audio" details on title pages. */
export function describeStreams(info: MediaInfo): { video: string; audio: string[]; subtitles: number } {
  const hdr = info.dv_profile != null ? `Dolby Vision (profile ${info.dv_profile})` : info.gamma === 'pq' ? 'HDR10' : info.gamma === 'hlg' ? 'HLG' : 'SDR';
  const codec = (info.video_codec && VIDEO_CODECS[info.video_codec]) ?? info.video_codec ?? 'Unknown';
  const video = [`${info.width}×${info.height}`, codec + (info.video_profile ? ` ${info.video_profile}` : ''), hdr].join(' · ');
  const audio = info.audio.map((a) => {
    const codecName = /atmos/i.test(`${a.profile} ${a.title}`)
      ? `${AUDIO_NAMES[a.codec ?? ''] ?? a.codec} Atmos`
      : (a.profile && /DTS-HD MA|DTS:X/i.test(a.profile) ? a.profile.match(/DTS-HD MA|DTS:X/i)![0] : (AUDIO_NAMES[a.codec ?? ''] ?? a.codec?.toUpperCase()));
    const ch = a.channels ? (a.channels >= 8 ? '7.1' : a.channels >= 6 ? '5.1' : a.channels === 2 ? 'Stereo' : a.channels === 1 ? 'Mono' : `${a.channels}ch`) : '';
    return [a.lang?.toUpperCase(), codecName, ch, a.title && !/atmos/i.test(a.title) ? a.title : ''].filter(Boolean).join(' · ');
  });
  return { video, audio, subtitles: info.subs.length };
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
