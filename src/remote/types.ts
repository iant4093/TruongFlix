/** Shapes exchanged between the browser app and the desktop app (over `/api/…`). */

export interface RemoteProfile {
  id: number;
  name: string;
  color: string;
  maturity: 'kids' | 'teen' | 'all';
  locked: boolean;
}

export interface RemoteItem {
  key: string;
  kind: 'movie' | 'tv';
  title: string;
  year: number | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
  certification: string | null;
  imdbRating: number | null;
  runtime: number | null;
  seasonCount: number;
  genres: string[];
  /** 0–1 for Continue Watching entries. */
  progress?: number;
  /** e.g. "S1:E3 · 12 min left". */
  hint?: string;
}

export interface RemoteRow {
  title: string;
  items: RemoteItem[];
}

export interface RemoteLibrary {
  featured: RemoteItem | null;
  rows: RemoteRow[];
  all: RemoteItem[];
}

export interface RemotePlayable {
  type: 'movie' | 'episode';
  id: number;
  label: string;
  resume: number;
}

export interface RemoteEpisode {
  id: number;
  season: number;
  episode: number;
  title: string;
  overview: string | null;
  still: string | null;
  runtime: number | null;
  progress: number;
  watched: boolean;
}

export interface RemoteTitle {
  item: RemoteItem;
  cast: string[];
  play: RemotePlayable | null;
  episodes: RemoteEpisode[];
}

export interface RemoteStream {
  token: string;
  /** Relative URL on the TruongFlix server. */
  url: string;
  /** Media time where the stream starts (converted streams start at the requested time). */
  offset: number;
  duration: number;
  mode: 'direct' | 'hls';
  title: string;
  subtitle: string | null;
  start: number;
  next: RemotePlayable | null;
}
