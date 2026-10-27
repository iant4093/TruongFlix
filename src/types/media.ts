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
  /** TMDB person id (titles scanned before this field existed don't have it). */
  id?: number;
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
  certification: string | null;
  collection_id: number | null;
  collection_name: string | null;
  trailer_key: string | null;
  file_size: number | null;
  media_info: string | null;
  segments: string | null;
  probed_mtime: number | null;
  enriched_at: string | null;
  probe_error: string | null;
  rt_score: number | null;
  metacritic: number | null;
  omdb_at: string | null;
  /** Scene during/after the credits (TMDB keywords): 'during' | 'after' | 'both' | '' (none) | null (unknown). */
  stinger: string | null;
  subs_auto_at: string | null;
  subs_auto_result: string | null;
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
  certification: string | null;
  trailer_key: string | null;
  tmdb_status: string | null;
  next_episode: string | null;
  enriched_at: string | null;
  rt_score: number | null;
  metacritic: number | null;
  omdb_at: string | null;
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
  file_size: number | null;
  media_info: string | null;
  segments: string | null;
  probed_mtime: number | null;
  intro_checked: number | null;
  probe_error: string | null;
  subs_auto_at: string | null;
  subs_auto_result: string | null;
}

/** Real stream information read by the Rust `media_probe` command. */
export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  video_codec: string | null;
  video_profile: string | null;
  gamma: string | null;
  primaries: string | null;
  dv_profile: number | null;
  size?: number | null;
  /** False when the end of the file can't be decoded (truncated / incomplete download). */
  tail_ok?: boolean | null;
  /** The file exists but couldn't be opened or decoded. */
  error?: string;
  audio: { lang: string | null; title: string | null; codec: string | null; profile: string | null; channels: number | null; default: boolean }[];
  subs: { lang: string | null; title: string | null; codec: string | null; forced: boolean }[];
  chapters: { title: string; time: number }[];
}

export type SegmentKind = 'intro' | 'recap' | 'credits';
export interface Segment {
  kind: SegmentKind;
  start: number;
  end: number;
  source: 'chapter' | 'audio' | 'manual';
}

export interface NextEpisode {
  season: number;
  episode: number;
  name: string;
  air_date: string;
}

/** One file of a movie that exists in several versions (e.g. 1080p and 4K). */
export interface MovieVersion {
  id: number;
  filePath: string;
  label: string;
  tech: TechInfo;
  fileSize: number | null;
}

export type Maturity = 'kids' | 'teen' | 'all';
export interface Profile {
  id: number;
  name: string;
  color: string;
  maturity: Maturity;
  created_at: string;
  /** Minutes of viewing allowed per day (0 = no limit). */
  daily_limit: number;
  /** "HH:MM" after which playback won't start, until `wake_time` ("" = no bedtime). */
  bedtime: string;
  wake_time: string;
  /** 4-digit PIN asked when switching to this profile ("" = none). */
  pin: string;
}

export type ProfileInput = Omit<Profile, 'id' | 'created_at'>;

/** A media folder on a network share (from the Rust `share_info` command). */
export interface ShareInfo {
  mount_point: string;
  url: string;
  host: string;
  kind: 'smb' | 'afp' | 'nfs' | 'windows';
  mac: string | null;
}

export interface AudioDevice {
  name: string;
  description: string;
}

export interface CollectionPart {
  tmdb_id: number;
  title: string;
  year: number | null;
  release_date: string | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
}
export interface CollectionRow {
  id: number;
  name: string;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  parts: string | null;
  fetched_at: string | null;
}

/** TMDB episode list for one season (cached), used to show missing and upcoming episodes. */
export interface SeasonEpisodeInfo {
  episode_number: number;
  name: string;
  overview: string | null;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
}

export interface WatchLogRow {
  profile_id: number;
  media_type: PlayableType;
  media_id: number;
  day: string;
  seconds: number;
  title: string | null;
  series_id: number | null;
  series_title: string | null;
  genres: string | null;
  season_number: number | null;
  episode_number: number | null;
  poster: string | null;
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
  /** Rotten Tomatoes critics score (%) and Metacritic score, from OMDb. */
  rtScore: number | null;
  metacritic: number | null;
  /** Movies: a scene during and/or after the credits. */
  stinger: 'during' | 'after' | 'both' | null;
  /** TV only: IMDb season averages keyed by season number. */
  imdbSeasons: Record<number, SeasonRating>;
  certification: string | null;
  trailerKey: string | null;
  collectionId: number | null;
  collectionName: string | null;
  /** TV: TMDB status ("Returning Series", "Ended", …) and the next scheduled episode. */
  tmdbStatus: string | null;
  nextEpisode: NextEpisode | null;
  /** TV: number of seasons according to TMDB (may exceed the seasons you have). */
  tmdbSeasons: number;
  /** Movies: every file of this title, best first (more than one = version picker). */
  versions: MovieVersion[];
  mediaInfo: MediaInfo | null;
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
  phase: 'idle' | 'walking' | 'diffing' | 'matching' | 'ratings' | 'analysis' | 'done' | 'error';
  current: number;
  total: number;
  message: string;
  added: number;
  removed: number;
  /** Background (folder-watcher) scan: the progress card stays hidden unless something changed. */
  quiet?: boolean;
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
  /** Netflix-style subtitle appearance for the built-in player. */
  subtitle_style: SubtitleStyle;
  /** Loudness levelling (night mode) and centre-channel/speech boost (dialogue boost). */
  audio_night: boolean;
  audio_dialogue: boolean;
  /** Detect intros from audio; skip them automatically. */
  intro_detection: boolean;
  skip_intro_auto: boolean;
  /** Watch media folders and update the library automatically. */
  watch_folders: boolean;
  /** Autoplay muted trailers in the home banner. */
  trailers_autoplay: boolean;
  /** Animated intro (and sound) at launch. */
  launch_intro: boolean;
  launch_intro_sound: boolean;
  /** Hover cards cycle through stills from the actual file. */
  hover_stills: boolean;
  /** Show the "Who's watching?" screen at launch when there are several profiles. */
  ask_profile: boolean;
  active_profile: number;
  /** Pause and ask "Are you still watching?" after this many episodes in a row without input (0 = never). */
  still_watching_after: number;
  /** mpv audio device ("auto" = system default) and receiver passthrough for Dolby/DTS. */
  audio_device: string;
  audio_passthrough: boolean;
  /** Audio delay (seconds) remembered per output device, keyed by mpv device name. */
  audio_delays: Record<string, number>;
  /** Pause when the screen locks, the display sleeps or the computer sleeps. */
  pause_on_lock: boolean;
  /** OMDb key for Rotten Tomatoes and Metacritic scores ("" = off). */
  omdb_api_key: string;
  /** Network shares behind media folders, keyed by media folder. */
  network_shares: Record<string, ShareInfo>;
  /** Download missing subtitles in the background (and fix the timing of inexact matches). */
  subtitles_auto: boolean;
  subtitles_auto_sync: boolean;
  /** Local date when OpenSubtitles' daily allowance ran out ("" = not paused). */
  subtitles_auto_paused: string;
  /** Library in a web browser on the local network. */
  remote_access: boolean;
  remote_code: string;
  remote_port: number;
}

export type SleepTimer = { mode: 'minutes'; minutes: number; endsAt: number } | { mode: 'episode' };

export interface SubtitleStyle {
  size: 'small' | 'medium' | 'large' | 'xlarge';
  color: 'white' | 'yellow' | 'cyan' | 'green' | 'magenta';
  background: 'none' | 'shadow' | 'translucent' | 'solid';
  font: 'sans' | 'serif' | 'mono';
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
  /** Every profile's watch state for these rows (added with profiles; absent in older entries). */
  state?: unknown[];
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

/** A Chromecast or DLNA TV on the network (from the Rust `cast_discover` command). */
export interface CastDevice {
  id: string;
  name: string;
  kind: 'chromecast' | 'dlna';
  host: string;
  port: number;
  model: string | null;
  av_transport: string | null;
  rendering: string | null;
}

export interface CastState {
  device: CastDevice;
  target: PlayTarget;
  title: string;
  subtitle: string | null;
  image: string | null;
  state: 'connecting' | 'buffering' | 'playing' | 'paused' | 'idle' | 'ended' | 'error';
  time: number;
  duration: number;
  /** Converted streams start at `offset`; the device reports time from there. */
  offset: number;
  message: string | null;
  next: PlayTarget | null;
  converting: boolean;
}

