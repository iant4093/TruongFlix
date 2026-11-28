import type { MediaInfo, Segment, SegmentKind, TechInfo } from '../types/media';
import { formatBytes } from '../lib/format';

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

function chapterKind(title: string): SegmentKind | null {
  if (RECAP_RE.test(title)) return 'recap';
  if (CREDITS_RE.test(title) && !/opening/i.test(title)) return 'credits';
  return INTRO_RE.test(title) ? 'intro' : null;
}

/**
 * Intro/recap/credits segments from chapter titles (e.g. "Opening", "Previously On", "End Credits").
 * Back-to-back chapters of one kind count as one. Some releases name the "Previously on…" recap
 * "Intro" as well: when two separate intro chapters open an episode, the last one is the intro and
 * the first one the recap.
 */
export function segmentsFromChapters(info: MediaInfo): Segment[] {
  const ch = info.chapters ?? [];
  const blocks: Segment[] = [];
  let prev: SegmentKind | null = null;
  for (let i = 0; i < ch.length; i++) {
    const kind = chapterKind(ch[i].title ?? '');
    const end = ch[i + 1]?.time ?? info.duration;
    if (kind && kind === prev) blocks[blocks.length - 1].end = end;
    else if (kind) blocks.push({ kind, start: ch[i].time, end, source: 'chapter' });
    prev = kind;
  }
  // Credits only count near the end; intros/recaps only near the start.
  const usable = blocks.filter(
    (b) => b.end - b.start >= 5 && (b.kind === 'credits' ? b.start >= info.duration * 0.6 : b.start <= Math.min(900, info.duration * 0.4)),
  );
  const intros = usable.filter((b) => b.kind === 'intro');
  const intro = intros[intros.length - 1];
  const recap = usable.find((b) => b.kind === 'recap' && (!intro || b.start < intro.start))
    ?? usable.find((b) => b.kind === 'recap')
    ?? (intros.length > 1 ? { ...intros[0], kind: 'recap' as const } : undefined);
  const credits = usable.find((b) => b.kind === 'credits');
  return [recap, intro, credits].filter((s): s is Segment => !!s);
}

/** Whether two ranges are mostly the same stretch (they share over half of the shorter one). */
function overlap(a: Segment, b: Segment): boolean {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.5 * Math.min(a.end - a.start, b.end - b.start);
}

/** A recap ends where the intro starts. */
function tidySegments(list: Segment[]): Segment[] {
  const intro = list.find((s) => s.kind === 'intro');
  return list.flatMap((s) => {
    if (s.kind !== 'recap' || s.source === 'manual' || !intro || s.end <= intro.start || s.start >= intro.end) return [s];
    const end = Math.min(s.end, intro.start);
    return end - s.start >= 5 ? [{ ...s, end }] : [];
  });
}

/**
 * A title's markers once its chapters are read. Ones set by hand win, then chapters. An intro found
 * from the audio (the stretch that repeats across the season) stays when there's no intro chapter,
 * or when it matches the intro chapter: then it gives the exact edges, which chapters often miss.
 */
export function mergeChapterSegments(existing: Segment[], fromChapters: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const kind of ['recap', 'intro', 'credits'] as const) {
    const manual = existing.find((s) => s.kind === kind && s.source === 'manual');
    const chapter = fromChapters.find((s) => s.kind === kind);
    const audio = existing.find((s) => s.kind === kind && s.source === 'audio');
    const pick = manual ?? (audio && (!chapter || overlap(audio, chapter)) ? audio : chapter);
    if (pick) out.push(pick);
  }
  return tidySegments(out);
}

/**
 * Markers with the intro found from the audio, or null when the file's intro chapter is somewhere
 * else (the audio then matched something other than the intro, such as clips two recaps share).
 */
export function withAudioIntro(existing: Segment[], range: [number, number]): Segment[] | null {
  const intro: Segment = { kind: 'intro', start: range[0], end: range[1], source: 'audio' };
  const chapter = existing.find((s) => s.kind === 'intro' && s.source === 'chapter');
  if (chapter && !overlap(chapter, intro)) return null;
  return tidySegments([...existing.filter((s) => s.kind !== 'intro'), intro]);
}

/** Same markers, in any order. */
export function sameSegments(a: Segment[], b: Segment[]): boolean {
  const key = (list: Segment[]) => list.map((s) => `${s.kind}:${s.source}:${s.start}:${s.end}`).sort().join('|');
  return key(a) === key(b);
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

/** Like formatBytes, but empty when the size is unknown. */
export function formatSize(bytes: number | null | undefined): string {
  return bytes ? formatBytes(bytes) : '';
}
