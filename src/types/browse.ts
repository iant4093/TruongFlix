import type { SearchResult } from '../services/tmdb';
import type { EpisodeMetadata } from '../services/db';

export interface CatalogDetail extends SearchResult {
  imdbId: string;
  certification: string;
  genres: string[];
  runtime: number | null;
  seasons: { number: number; name: string; count: number; airDate: string | null }[];
  status: string;
  nextSeason: number | null;
  lastSeason: number | null;
  lastEpisode: number | null;
}

export interface CatalogSeason {
  episodes: EpisodeMetadata[];
  complete: boolean;
}

export type BrowseScope = { kind: 'movie' } | { kind: 'episode'; season: number; episode: number }
  | { kind: 'season'; season: number; expected: number[]; complete: boolean };

export type BrowseTarget = BrowseScope & {
  imdbId: string;
  title: string;
  year: number | null;
  quality: '1080p' | '4K';
};

export interface SourceRelease {
  id: string;
  imdbId: string;
  title: string;
  seeders: number | null;
  size: string;
}

export interface SourceEvent {
  requestId: string;
  kind: 'results' | 'magnet' | 'closed' | 'error' | 'ready' | 'challenge';
  page?: number;
  releases?: SourceRelease[];
  magnet?: string;
  releaseId?: string;
  message?: string;
}
