import { invoke } from '@tauri-apps/api/core';
import type { MediaItem } from '../types/media';
import { getTrailerCandidates } from './tmdb';

export interface TrailerSource {
  videoUrl: string;
  audioUrl: string | null;
  width: number;
  height: number;
}
const pending = new Map<string, Promise<TrailerSource>>();

/** Native resolution is cached for 30 minutes; only loopback media URLs reach the page. */
export function resolveTrailer(item: MediaItem, refresh = false): Promise<TrailerSource> {
  const key = `${item.kind}/${item.tmdbId}/${item.trailerKey}/${refresh}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const resolve = async () => {
    const load = (key: string) => invoke<TrailerSource>('trailer_resolve', { key, refresh });
    try {
      if (item.trailerKey) return await load(item.trailerKey);
    } catch { /* Try another official trailer when the stored video was removed or restricted. */ }
    if (item.tmdbId != null) {
      const candidates = await getTrailerCandidates(item.kind, item.tmdbId);
      for (const candidate of candidates.filter((key) => key !== item.trailerKey).slice(0, 2)) {
        try { return await load(candidate); } catch { /* bounded alternative search */ }
      }
    }
    throw new Error('No available trailer was found.');
  };
  const promise = resolve().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
