/** Music library shapes shared by the desktop app, the browser app and the `/api/music` routes. */

export interface MusicTrack {
  id: number;
  title: string;
  /** Track artist. */
  artist: string;
  artistId: number;
  album: string;
  albumId: number;
  /** Album artist (falls back to the track artist). */
  albumArtist: string;
  albumArtistId: number;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  /** Seconds. */
  duration: number;
  /** "mp3" | "flac" | "aac" | "alac" | "vorbis" | "opus" | "wav" | … */
  codec: string;
  /** Hz, when known. */
  sampleRate?: number | null;
  /** Bits per sample (lossless files), when known. */
  bitDepth?: number | null;
  /** kbit/s, when known. */
  bitrate?: number | null;
  /** Cached cover name (see `MusicApi.artUrl`). */
  art: string | null;
  favourite: boolean;
  plays: number;
  /** Epoch ms of the last play by this profile. */
  lastPlayed: number | null;
  /** Epoch ms when the file joined the library. */
  addedAt: number;
  /** Lyrics came with the file (embedded or a sidecar .lrc). */
  hasLyrics: boolean;
}

export interface MusicAlbum {
  id: number;
  title: string;
  artist: string;
  artistId: number;
  year: number | null;
  genre: string | null;
  art: string | null;
  trackIds: number[];
  duration: number;
  addedAt: number;
  lastPlayed: number | null;
  plays: number;
}

export interface MusicArtist {
  id: number;
  name: string;
  art: string | null;
  albumIds: number[];
  trackCount: number;
}

export interface MusicPlaylist {
  id: number;
  name: string;
  trackIds: number[];
  updatedAt: number;
}

export interface MusicLibrary {
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
  playlists: MusicPlaylist[];
}

export interface MusicLyrics {
  /** LRC (when `synced`) or plain text. */
  text: string;
  synced: boolean;
  source: 'sidecar' | 'embedded' | 'lrclib' | 'netease' | 'kugou';
  instrumental?: boolean;
}

export interface MusicStream {
  url: string;
  /** Converted to AAC because this player can't decode the original. */
  transcoded: boolean;
}
