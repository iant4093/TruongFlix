/** Raw file record returned by the Rust `scan_media_folders` command. */
export interface RawVideoFile {
  file_path: string;
  filename: string;
  parent_folder_name: string;
  grandparent_folder_name: string;
  file_size: number;
  mtime: number;
}

export interface CastMember {
  name: string;
  character?: string;
  job?: string;
  profile_path?: string | null;
}

export interface TechInfo {
  resolution: string | null;
  video_codec: string | null;
  hdr_format: string | null;
  audio_codec: string | null;
}

/** SQLite row shapes (booleans come back as 0/1 integers). */
export interface MovieRow extends TechInfo, ImdbInfo {
  id: number;
  tmdb_id: number | null;
  file_path: string;
  raw_filename: string;
  file_mtime: number;
  title: string;
  original_title: string | null;
  year: number | null;
  overview: string | null;
  tagline: string | null;
  runtime: number | null;
  vote_average: number | null;
  genres: string | null;
  cast_crew: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  logo_path: string | null;
  progress_seconds: number;
  duration_seconds: number;
  watched: number;
  my_list: number;
  last_watched_at: string | null;
  created_at: string;
}

export interface SeriesRow extends ImdbInfo {
  imdb_season_ratings: string | null;
  id: number;
  tmdb_id: number;
  folder_path: string | null;
  title: string;
  year: number | null;
  overview: string | null;
  vote_average: number | null;
  genres: string | null;
  cast_crew: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  logo_path: string | null;
  number_of_seasons: number;
  my_list: number;
  last_watched_at: string | null;
  created_at: string;
}

export interface EpisodeRow extends TechInfo, ImdbInfo {
  id: number;
  series_id: number;
  tmdb_episode_id: number | null;
  file_path: string;
  raw_filename: string;
  file_mtime: number;
  season_number: number;
  episode_number: number;
  title: string;
  overview: string | null;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
  progress_seconds: number;
  duration_seconds: number;
  watched: number;
  last_watched_at: string | null;
}

export type MediaKind = 'movie' | 'tv';
export type PlayableType = 'movie' | 'episode';

/** Unified, UI-friendly view of a movie or a TV series. */
export interface MediaItem {
  key: string; // e.g. "movie-12" / "tv-4"
  kind: MediaKind;
  id: number;
  tmdbId: number | null;
  title: string;
  year: number | null;
  overview: string;
  tagline: string | null;
  voteAverage: number;
  genres: string[];
  cast: CastMember[];
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
  runtime: number | null; // minutes (movies)
  seasonCount: number; // tv: number of seasons present in the library
  episodeCount: number;
  tech: TechInfo;
  myList: boolean;
  createdAt: string;
  lastWatchedAt: string | null;
  matched: boolean;
  imdbId: string | null;
  imdbRating: number | null;
  imdbVotes: number | null;
  /** TV only: IMDb season averages keyed by season number. */
  imdbSeasons: Record<number, SeasonRating>;
  /** Movies only. */
  filePath: string | null;
  rawFilename: string | null;
  progressSeconds: number;
  durationSeconds: number;
  watched: boolean;
}

/** What actually gets handed to VLC. */
export interface PlayTarget {
  type: PlayableType;
  id: number;
  filePath: string;
  startTime: number;
  label: string;
}

/** A "Continue Watching" entry: the media item plus the exact file to resume. */
export interface ContinueEntry {
  item: MediaItem;
  target: PlayTarget;
  episode: EpisodeRow | null;
  progress: number; // 0..1
  remainingSeconds: number;
  sortDate: string;
}

export interface ScanState {
  running: boolean;
  phase: 'idle' | 'walking' | 'diffing' | 'matching' | 'ratings' | 'done' | 'error';
  current: number;
  total: number;
  message: string;
  added: number;
  removed: number;
}

export interface PlaybackState {
  active: boolean;
  type: PlayableType | null;
  id: number | null;
  time: number;
  length: number;
}

export interface Settings {
  tmdb_api_key: string;
  vlc_executable_path: string;
  media_directories: string[];
  /** Optional. Subtitle search/download is disabled entirely while this is empty. */
  opensubtitles_api_key: string;
  /** Optional account login: raises the daily download quota above the anonymous 5/day. */
  opensubtitles_username: string;
  opensubtitles_password: string;
  /** Preferred subtitle language (OpenSubtitles code, e.g. "en", "pt-br"). */
  subtitle_language: string;
  /** Move videos sitting loose in a media folder into their own folder during scans. */
  organize_loose_files: boolean;
  /** Show IMDb ratings (from IMDb's public datasets). */
  imdb_enabled: boolean;
  /** ISO timestamp of the last successful IMDb ratings sync. */
  imdb_last_sync: string;
  /** 'builtin' = embedded mpv player (falls back to VLC when unavailable), 'vlc' = external VLC. */
  player_engine: 'builtin' | 'vlc';
  /** Check for app updates at startup (at most daily). */
  updates_auto_check: boolean;
  /** ISO timestamp of the last update check. */
  updates_last_check: string;
}

/** Built-in player engine availability (from the Rust `player_status` command). */
export interface EngineStatus {
  available: boolean;
  reason: string | null;
  mpv_version: string | null;
  ffmpeg_version: string | null;
  library: string | null;
}

/** Live state of the built-in player (`player-state` events). */
export interface BuiltinPlayerState {
  time: number;
  duration: number;
  paused: boolean;
  eof: boolean;
  buffering: boolean;
  seeking: boolean;
  idle: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  sub_delay: number;
  audio_delay: number;
  gamma: string | null;
  loaded: boolean;
}

/** One entry of mpv's `track-list`. */
export interface PlayerTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title?: string;
  lang?: string;
  codec?: string;
  'codec-desc'?: string;
  'demux-channel-count'?: number;
  'audio-channels'?: number;
  default?: boolean;
  forced?: boolean;
  external?: boolean;
  'external-filename'?: string;
  'hearing-impaired'?: boolean;
  selected?: boolean;
  image?: boolean;
}

export interface PlayerSession {
  target: PlayTarget;
  itemKey: string | null;
  title: string;
  /** e.g. "E3 · In Perpetuity" */
  subtitle: string | null;
  overview: string | null;
  logo: string | null;
  next: PlayTarget | null;
  nextLabel: string | null;
}

export interface ImdbInfo {
  imdb_id: string | null;
  imdb_rating: number | null;
  imdb_votes: number | null;
}

export interface SeasonRating {
  rating: number;
  count: number;
}

export interface FileMove {
  from: string;
  to: string;
}

/** A "Recently Deleted" entry: where the files went plus the DB rows needed to restore them. */
export interface TrashRow {
  id: number;
  label: string;
  kind: 'movie' | 'tv' | 'episode';
  poster_path: string | null;
  entry_dir: string;
  items: string; // JSON FileMove[]
  snapshot: string; // JSON TrashSnapshot
  size_bytes: number;
  deleted_at: string;
}

export interface TrashSnapshot {
  movies: MovieRow[];
  series: SeriesRow | null;
  episodes: EpisodeRow[];
  subtitles: SubtitleRow[];
}

export interface SubtitleRow {
  id: number;
  media_type: PlayableType;
  media_id: number;
  language: string;
  file_path: string;
  source: 'opensubtitles' | 'local';
  release_name: string | null;
  hash_match: number;
  opensubtitles_file_id: number | null;
  selected: number;
  created_at: string;
}
