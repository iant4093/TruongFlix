import type { MusicLibrary, MusicLyrics, MusicPinKind, MusicPlaylist, MusicStream, MusicTrack } from './types';

/** The cover a playlist shows after a change (see `MusicPlaylist.cover`). */
export type PlaylistCover = Pick<MusicPlaylist, 'cover' | 'customCover'>;

/**
 * What the music screens and player need. The desktop app answers from its own database; the
 * browser app asks the PC over `/api/music/…` (see `httpMusicApi`), which runs the same code.
 */
export interface MusicApi {
  library(): Promise<MusicLibrary>;
  /** `refresh` looks online again even if the song wasn't found last time. */
  lyrics(trackId: number, refresh?: boolean): Promise<MusicLyrics | null>;
  /** A URL the player can load for this song. */
  /** `keep`: the stream URLs the player still uses (playing and preloaded), never released for this one. */
  stream(track: MusicTrack, keep?: string[]): Promise<MusicStream>;
  /** The song was listened to (counts toward Listen Now and plays). */
  played(trackId: number): Promise<void>;
  /** How long the counted play was listened to, sent when the song is left (for Wrapped). */
  listened(trackId: number, seconds: number): Promise<void>;
  setFavourite(trackId: number, value: boolean): Promise<void>;
  createPlaylist(name: string, trackIds?: number[]): Promise<MusicPlaylist>;
  renamePlaylist(id: number, name: string): Promise<void>;
  deletePlaylist(id: number): Promise<void>;
  /** Replaces the playlist's songs (add, remove and reorder all go through this). */
  setPlaylistTracks(id: number, trackIds: number[]): Promise<void>;
  addToPlaylist(id: number, trackIds: number[]): Promise<void>;
  /** Sets the short description shown under the name ('' takes it off). Returns what was kept. */
  setPlaylistDescription(id: number, description: string): Promise<string>;
  /** Sets the cover to a picture (its bytes), or null to go back to the imported artwork or the mosaic. */
  setPlaylistCover(id: number, image: Uint8Array | null): Promise<PlaylistCover>;
  /**
   * Desktop only (imports run there): keeps the artwork of the playlist this one was imported
   * from. Null when it already has that artwork.
   */
  importPlaylistCover?(id: number, url: string): Promise<PlaylistCover | null>;
  /** Pins an album or playlist to the top of Listen Now (added at the end), or unpins it. */
  setPinned(kind: MusicPinKind, id: number, value: boolean): Promise<void>;
  /** Image URL for a cached cover name. */
  artUrl(art: string | null | undefined): string | null;
  /**
   * Desktop only: asks, then moves a song's or album's files to Recently deleted and takes them out
   * of the library. False when cancelled or it couldn't (the reason is shown).
   */
  deleteMusic?(target: MusicDeleteTarget): Promise<boolean>;
  /** Desktop only: shows the first of these songs in File Explorer / Finder, selected. */
  revealMusic?(trackIds: number[]): Promise<void>;
}

export type MusicDeleteTarget =
  | { kind: 'song'; trackId: number }
  | { kind: 'album'; albumId: number }
  /** Several songs picked together. */
  | { kind: 'songs'; trackIds: number[] };

/** Codecs `audio` can decode here (the PC converts anything else to AAC). */
/**
 * Safari (every iPhone and iPad browser, and the Mac desktop app's web view): it plays FLAC, but
 * seeks inside it only roughly, so after a seek the song and its lyrics drifted apart. It gets the
 * same music as lossless ALAC instead, which it seeks in exactly.
 */
export const roughFlacSeeking = (ua = typeof navigator !== 'undefined' ? navigator.userAgent : '', touch = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0) =>
  /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1) || (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\/|Android/.test(ua));

export function playableCodecs(audio: Pick<HTMLAudioElement, 'canPlayType'> = typeof Audio !== 'undefined' ? new Audio() : { canPlayType: () => '' }, roughFlac = roughFlacSeeking()) {
  const tests: Record<string, string> = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    alac: 'audio/mp4; codecs="alac"',
    vorbis: 'audio/ogg; codecs="vorbis"',
    opus: 'audio/ogg; codecs="opus"',
    wav: 'audio/wav',
  };
  return Object.entries(tests)
    .filter(([codec, mime]) => audio.canPlayType(mime) !== '' && !(codec === 'flac' && roughFlac))
    .map(([codec]) => codec);
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export type Fetcher = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** The browser app's client for `/api/music/…`. `who` adds the profile (and unlock key). */
export function httpMusicApi(fetcher: Fetcher, who: { id: number; key?: string }, artBase = '/music-art/'): MusicApi {
  const profile = { profile: who.id, key: who.key };
  const post = <T>(path: string, body: Record<string, unknown> = {}) => fetcher<T>(path, { method: 'POST', body: { ...profile, ...body } });
  const query = `?profile=${encodeURIComponent(who.id)}${who.key ? `&key=${encodeURIComponent(who.key)}` : ''}`;
  let codecs: string[] | null = null;
  return {
    library: () => fetcher<MusicLibrary>(`/music/library${query}`),
    lyrics: (trackId, refresh) => fetcher<MusicLyrics | null>(`/music/lyrics${query}&id=${trackId}${refresh ? '&refresh=1' : ''}`),
    stream: (track, keep = []) => post<MusicStream>('/music/stream', { id: track.id, codecs: (codecs ??= playableCodecs()), keep }),
    played: (trackId) => post<unknown>('/music/played', { id: trackId }).then(() => undefined),
    listened: (trackId, seconds) => post<unknown>('/music/listened', { id: trackId, seconds }).then(() => undefined),
    setFavourite: (trackId, value) => post<unknown>('/music/favourite', { id: trackId, value }).then(() => undefined),
    createPlaylist: (name, trackIds = []) => post<MusicPlaylist>('/music/playlists/create', { name, trackIds }),
    renamePlaylist: (id, name) => post<unknown>('/music/playlists/rename', { id, name }).then(() => undefined),
    deletePlaylist: (id) => post<unknown>('/music/playlists/delete', { id }).then(() => undefined),
    setPlaylistTracks: (id, trackIds) => post<unknown>('/music/playlists/tracks', { id, trackIds }).then(() => undefined),
    addToPlaylist: (id, trackIds) => post<unknown>('/music/playlists/add', { id, trackIds }).then(() => undefined),
    setPlaylistDescription: (id, description) => post<{ description: string }>('/music/playlists/description', { id, description }).then((r) => r.description),
    setPlaylistCover: (id, image) => post<PlaylistCover>('/music/playlists/cover', { id, image: image ? toBase64(image) : null }),
    setPinned: (kind, id, value) => post<unknown>('/music/pin', { kind, id, value }).then(() => undefined),
    artUrl: (art) => (art ? `${artBase}${art}` : null),
  };
}
