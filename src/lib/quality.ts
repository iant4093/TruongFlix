/** Playback and download quality choices shared by the browser app and the desktop app. */

export type QualityStep = '2160' | '1080' | '720' | '480';
/** 'original' plays or saves the file as it is (converted at its own size when a browser can't play it). */
export type QualityRes = 'original' | QualityStep;
export type QualityLevel = 'low' | 'medium' | 'high';

export interface Quality {
  res: QualityRes;
  level: QualityLevel;
}

/** Highest first. */
export const QUALITY_STEPS: QualityStep[] = ['2160', '1080', '720', '480'];
export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high'];

/** Video bitrate targets in kbit/s. */
export const BITRATES: Record<QualityStep, Record<QualityLevel, number>> = {
  '2160': { low: 12000, medium: 20000, high: 35000 },
  '1080': { low: 4000, medium: 6000, high: 10000 },
  '720': { low: 2000, medium: 3000, high: 5000 },
  '480': { low: 800, medium: 1200, high: 2000 },
};
/** Peak bitrate as a multiple of the target. */
export const PEAK_FACTOR = 1.5;
/** AAC stereo in every conversion. */
export const AUDIO_KBPS = 192;

/** Today's conversion: 1080p at the highest bitrate. */
export const DEFAULT_CONVERTED: Quality = { res: '1080', level: 'high' };

const RES_LABELS: Record<QualityRes, string> = { original: 'Original', '2160': '4K', '1080': '1080p', '720': '720p', '480': '480p' };
const LEVEL_LABELS: Record<QualityLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export const resLabel = (res: QualityRes) => RES_LABELS[res];
export const levelLabel = (level: QualityLevel) => LEVEL_LABELS[level];

export function qualityLabel(q: Quality): string {
  return q.res === 'original' ? RES_LABELS.original : `${RES_LABELS[q.res]} · ${LEVEL_LABELS[q.level]}`;
}

export const isQualityRes = (v: unknown): v is QualityRes => typeof v === 'string' && Object.prototype.hasOwnProperty.call(RES_LABELS, v);
export const isQualityLevel = (v: unknown): v is QualityLevel => typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_LABELS, v);

/** Estimated size in bytes of a conversion at `videoKbps` for `seconds`. */
export function estimateBytes(videoKbps: number, seconds: number): number {
  return Math.round(((videoKbps + AUDIO_KBPS) * 1000 * Math.max(0, seconds)) / 8);
}
