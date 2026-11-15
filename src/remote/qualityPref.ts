/** The last quality picked in this browser, for playback and for downloads. */
import { isQualityLevel, isQualityRes, type Quality } from '../lib/quality';

const KEYS = { play: 'tf-remote-quality', download: 'tf-remote-download-quality' } as const;
type Use = keyof typeof KEYS;

export function savedQuality(use: Use = 'play'): Quality | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEYS[use]) ?? 'null') as Record<string, unknown> | null;
    return v && isQualityRes(v.res) && isQualityLevel(v.level) ? { res: v.res, level: v.level } : undefined;
  } catch {
    return undefined;
  }
}

export function saveQuality(q: Quality, use: Use = 'play') {
  try {
    localStorage.setItem(KEYS[use], JSON.stringify({ res: q.res, level: q.level }));
  } catch {
    // Private browsing may refuse storage; the choice just isn't remembered.
  }
}
