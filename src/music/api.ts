import type { MusicLibrary, MusicLyrics, MusicPlaylist, MusicStream, MusicTrack } from './types';

/**
 * What the music screens and player need. The desktop app answers from its own database; the
 * browser app asks the PC over `/api/music/…` (see `httpMusicApi`), which runs the same code.
 */
export interface MusicApi {
  library(): Promise<MusicLibrary>;
  /** `refresh` looks online again even if the song wasn't found last time. */
  lyrics(trackId: number, refresh?: boolean): Promise<MusicLyrics | null>;
  /** A URL the player can load for this song. */
  stream(track: MusicTrack): Promise<MusicStream>;
  /** The song was listened to (counts toward Listen Now and plays). */
  played(trackId: number): Promise<void>;
  setFavourite(trackId: number, value: boolean): Promise<void>;
  createPlaylist(name: string, trackIds?: number[]): Promise<MusicPlaylist>;
  renamePlaylist(id: number, name: string): Promise<void>;
  deletePlaylist(id: number): Promise<void>;
  /** Replaces the playlist's songs (add, remove and reorder all go through this). */
  setPlaylistTracks(id: number, trackIds: number[]): Promise<void>;
  addToPlaylist(id: number, trackIds: number[]): Promise<void>;
  /** Image URL for a cached cover name. */
  artUrl(art: string | null | undefined): string | null;
}

/** Codecs `audio` can decode here (the PC converts anything else to AAC). */
export function playableCodecs(audio: Pick<HTMLAudioElement, 'canPlayType'> = typeof Audio !== 'undefined' ? new Audio() : { canPlayType: () => '' }) {
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
    .filter(([, mime]) => audio.canPlayType(mime) !== '')
    .map(([codec]) => codec);
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
    stream: (track) => post<MusicStream>('/music/stream', { id: track.id, codecs: (codecs ??= playableCodecs()) }),
    played: (trackId) => post<unknown>('/music/played', { id: trackId }).then(() => undefined),
    setFavourite: (trackId, value) => post<unknown>('/music/favourite', { id: trackId, value }).then(() => undefined),
    createPlaylist: (name, trackIds = []) => post<MusicPlaylist>('/music/playlists/create', { name, trackIds }),
    renamePlaylist: (id, name) => post<unknown>('/music/playlists/rename', { id, name }).then(() => undefined),
    deletePlaylist: (id) => post<unknown>('/music/playlists/delete', { id }).then(() => undefined),
    setPlaylistTracks: (id, trackIds) => post<unknown>('/music/playlists/tracks', { id, trackIds }).then(() => undefined),
    addToPlaylist: (id, trackIds) => post<unknown>('/music/playlists/add', { id, trackIds }).then(() => undefined),
    artUrl: (art) => (art ? `${artBase}${art}` : null),
  };
}
