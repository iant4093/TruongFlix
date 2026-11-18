/** Shapes exchanged between the browser app and the desktop app (over `/api/…`). */
import type { Quality, QualityLevel, QualityRes } from '../lib/quality';

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
  rtScore?: number | null;
  metacritic?: number | null;
  stinger?: 'during' | 'after' | 'both' | null;
  runtime: number | null;
  seasonCount: number;
  genres: string[];
  /** 0–1 for Continue Watching entries. */
  progress?: number;
  /** e.g. "S1:E3 · 12 min left". */
  hint?: string;
  tagline?: string | null;
  myList?: boolean;
  watched?: boolean;
  imdbVotes?: number | null;
  /** The best file's picture and sound: "4K", "Dolby Vision", "Atmos", "5.1"… */
  badges?: string[];
  /** TV: "Returning Series", "Ended"… */
  status?: string | null;
  /** TV: the next episode to air, e.g. "S3:E2 · Mar 4". */
  nextAir?: string | null;
}

export interface RemotePerson {
  name: string;
  /** The character (cast) or the job (crew). */
  role: string | null;
  photo: string | null;
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
  /** Cast with photos and characters (newer PCs only). */
  people?: RemotePerson[];
  /** Directors (movies) or creators (TV). */
  crew?: RemotePerson[];
  /** IMDb's average for each season. */
  seasonRatings?: Record<number, number>;
  /** Titles in your library like this one. */
  similar?: RemoteItem[];
  /** The other films of its collection that you have. */
  collection?: { name: string; items: RemoteItem[] } | null;
}

export interface RemoteAudioTrack {
  id: number;
  label: string;
  detail: string | null;
  selected: boolean;
}

export interface RemoteSubTrack {
  id: number;
  label: string;
  detail: string | null;
  selected: boolean;
}

export interface RemoteChapter {
  title: string;
  time: number;
}

export interface RemoteSegment {
  kind: 'intro' | 'recap' | 'credits';
  start: number;
  end: number;
}

export interface RemoteSubStyle {
  size: 'small' | 'medium' | 'large' | 'xlarge';
  background: 'none' | 'shadow' | 'translucent' | 'solid';
}

/** What the desktop app is playing, for the browser app's "Playing on …" remote. */
export interface RemoteNowPlaying {
  active: boolean;
  /** The computer's name. */
  pc: string;
  source?: 'player' | 'live' | 'cast';
  /** The TV's name while casting. */
  castDevice?: string | null;
  type?: 'movie' | 'episode' | 'live';
  id?: number | string;
  itemKey?: string | null;
  title?: string;
  subtitle?: string | null;
  art?: string | null;
  poster?: string | null;
  logo?: string | null;
  time?: number;
  duration?: number;
  paused?: boolean;
  buffering?: boolean;
  /** 0–100, or null when the device doesn't report it. */
  volume?: number | null;
  muted?: boolean;
  fullscreen?: boolean;
  audioTracks?: RemoteAudioTrack[];
  subTracks?: RemoteSubTrack[];
  next?: string | null;
  /** "Are you still watching?" and similar prompts showing on the PC. */
  prompt?: string | null;
  can?: { seek: boolean; skip: boolean; volume: boolean; tracks: boolean; next: boolean; fullscreen: boolean };
}

export type RemoteCommandAction = 'play' | 'pause' | 'toggle' | 'seek' | 'skip' | 'volume' | 'mute' | 'audio' | 'subtitle' | 'next' | 'stop' | 'fullscreen';

/** A quality the browser may pick for one file (never above the source). */
export interface RemoteQualityOption {
  res: QualityRes;
  label: string;
  /** Original only: false when the file is converted at its own resolution because the browser can't play it. */
  asIs?: boolean;
  /** Estimated download size in bytes per bitrate level (Original: `high` only; null when unknown). */
  sizes: Partial<Record<QualityLevel, number | null>>;
}

export interface RemoteQualities {
  options: RemoteQualityOption[];
  default: Quality;
}

export interface RemoteStream {
  token: string;
  /** Relative URL on the TruongFlix server. */
  url: string;
  /** Media time where the stream starts (0 for direct & VOD HLS). */
  offset: number;
  duration: number;
  mode: 'direct' | 'hls';
  title: string;
  subtitle: string | null;
  start: number;
  next: RemotePlayable | null;
  aid: number | null;
  /** Selected mpv subtitle id, or 0 when subtitles are off. */
  sid: number;
  audioTracks: RemoteAudioTrack[];
  subTracks: RemoteSubTrack[];
  chapters: RemoteChapter[];
  segments: RemoteSegment[];
  stinger: 'during' | 'after' | 'both' | null;
  subStyle: RemoteSubStyle;
  /** The quality playing (may be lower than asked when the source is smaller). */
  quality: Quality;
  qualities: RemoteQualityOption[];
}

/** A file prepared on the PC for saving in the browser. */
export interface RemoteDownload {
  token: string;
  /** Relative URL of the bytes, fetched with byte ranges. */
  url: string;
  /** 'file': the original file; 'convert': an MP4 the PC converts first (poll `/download/status`). */
  mode: 'file' | 'convert';
  mime: string;
  quality: Quality;
  itemKey: string | null;
  title: string;
  subtitle: string | null;
  duration: number;
  /** Expected size in bytes, when known. */
  estimate: number | null;
  chapters: RemoteChapter[];
  segments: RemoteSegment[];
  stinger: 'during' | 'after' | 'both' | null;
}

export interface RemoteDownloadStatus {
  state: 'converting' | 'ready' | 'failed';
  /** 0–1. */
  progress: number;
  error: string | null;
}

/** A Live TV channel from the PC's sources. */
export interface RemoteLiveChannel {
  playlistId: string;
  id: string;
  name: string;
  group: string;
  /** The source's name, as the user typed it. */
  source: string;
  kind: 'm3u' | 'web';
  /** Web channels: the web player link, which plays right in the browser. */
  web: string | null;
}

export interface RemoteLiveTeam {
  name: string;
  abbreviation: string;
  score: string;
  color: string;
  logo: string;
  rank?: number;
}

export interface RemoteLiveEvent {
  id: string;
  name: string;
  league: string;
  leagueLabel: string;
  date: string;
  status: 'live' | 'upcoming' | 'finished';
  detail: string;
  broadcasts: string[];
  teams: RemoteLiveTeam[];
  /** Channels that carry this game. */
  channels: RemoteLiveChannel[];
}

export interface RemoteLive {
  events: RemoteLiveEvent[];
  channels: RemoteLiveChannel[];
  /** Some leagues could not be refreshed. */
  partial: boolean;
}
