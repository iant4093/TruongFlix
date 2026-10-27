import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Stable cache key for a file version (path + modification time). */
export function frameKey(path: string, mtime: number): string {
  let h = 2166136261;
  for (const ch of `${path}|${mtime}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return `${(h >>> 0).toString(16)}-${mtime}`;
}

export interface FrameReady {
  lane: string;
  key: string;
  index: number;
  time: number;
  /** Ready to use as an <img src>. */
  url: string;
}

/**
 * Extracts JPEG frames with the bundled player engine (cached on disk). `onFrame` receives each
 * frame as it lands; starting a new request on the same lane cancels the previous one.
 */
export async function extractFrames(
  opts: { path: string; mtime: number; times: number[]; width: number; lane: 'scrub' | 'stills' | 'chapters' },
  onFrame: (f: FrameReady) => void,
): Promise<void> {
  const key = frameKey(opts.path, opts.mtime);
  const unlisten = await listen<{ lane: string; key: string; index: number; time: number; path: string }>('frame-ready', ({ payload }) => {
    if (payload.key === key && payload.lane === opts.lane) onFrame({ ...payload, url: /^https?:/.test(payload.path) ? payload.path : convertFileSrc(payload.path) });
  });
  try {
    await invoke('extract_frames', { path: opts.path, key, times: opts.times, width: opts.width, lane: opts.lane });
  } finally {
    unlisten();
  }
}

/** Stops any extraction running on `lane` (e.g. when playback ends). */
export function cancelFrames(lane: 'scrub' | 'stills' | 'chapters') {
  void invoke('extract_frames', { path: '', key: 'cancel', times: [], width: 1, lane }).catch(() => {});
}

/** Times ordered coarse-to-fine, so the whole timeline gets rough coverage quickly. */
export function coarseToFine(count: number, interval: number, offset = 0): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let step = 32; step >= 1; step /= 2) {
    for (let i = 0; i < count; i += step) {
      if (!seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    }
  }
  return order.map((i) => Math.round((offset + i * interval) * 10) / 10);
}
