import type { Profile } from '../types/media';
import { ApiError, rateLimit, type Caller } from './remotecontrol';
import * as mdb from './musicdb';
import { lyricsFor, registerMusicStream, StreamRing } from './music';
import { streamUrl } from './streaming';

/**
 * `/api/music/…` for the browser app. The profile has already been checked (and unlocked when it
 * has a PIN) by `remoteapi.route`; plays, favourites and playlists are that profile's own.
 */

/** Each signed-in browser keeps its current and preloaded song streams; older ones are released. */
const rings = new Map<string, StreamRing>();

export function endMusicSession(session: string) {
  rings.get(session)?.clear();
  rings.delete(session);
}

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'Bad request');
  return n;
};

const notFound = (e: unknown): never => {
  if (e instanceof mdb.PlaylistNotFound) throw new ApiError(404, 'Playlist not found');
  throw e;
};

const CODECS = new Set(['mp3', 'flac', 'aac', 'alac', 'vorbis', 'opus', 'wav']);

export async function musicRoute(caller: Caller, profile: Profile, method: string, path: string, query: Record<string, string>, body: Record<string, unknown>): Promise<unknown> {
  if (method === 'GET' && path === '/music/library') {
    rateLimit(caller, 'music-library', 30, 60_000);
    return mdb.loadMusic(profile.id);
  }
  if (method === 'GET' && path === '/music/lyrics') {
    rateLimit(caller, 'music-lyrics', 60, 60_000);
    return (await lyricsFor(id(query.id), undefined, query.refresh === '1')) ?? null;
  }
  if (method !== 'POST') throw new ApiError(404, 'Unknown endpoint');
  switch (path) {
    case '/music/stream': {
      rateLimit(caller, 'music-stream', 60, 60_000);
      const codecs = Array.isArray(body.codecs) ? body.codecs.map(String).filter((c) => CODECS.has(c)) : [];
      const reg = await registerMusicStream(id(body.id), codecs);
      if (!reg) throw new ApiError(404, 'Not found');
      let ring = rings.get(caller.session);
      if (!ring) rings.set(caller.session, (ring = new StreamRing()));
      ring.add(reg.token, Array.isArray(body.keep) ? body.keep.slice(0, 4).map(String) : []);
      const url = await streamUrl(reg.token, 0);
      return { url: url.path, transcoded: reg.transcoded };
    }
    case '/music/played':
      rateLimit(caller, 'music-played', 30, 60_000);
      if (!(await mdb.recordPlay(profile.id, id(body.id)))) throw new ApiError(404, 'Not found');
      return { ok: true };
    case '/music/favourite':
      if (!(await mdb.setFavourite(profile.id, id(body.id), !!body.value))) throw new ApiError(404, 'Not found');
      return { ok: true };
    case '/music/playlists/create':
      rateLimit(caller, 'music-playlist', 30, 60_000);
      return mdb.createPlaylist(profile.id, body.name, body.trackIds);
    case '/music/playlists/rename':
      await mdb.renamePlaylist(profile.id, id(body.id), body.name).catch(notFound);
      return { ok: true };
    case '/music/playlists/delete':
      await mdb.deletePlaylist(profile.id, id(body.id)).catch(notFound);
      return { ok: true };
    case '/music/playlists/tracks':
      return { trackIds: await mdb.setPlaylistTracks(profile.id, id(body.id), body.trackIds).catch(notFound) };
    case '/music/playlists/add':
      return { trackIds: await mdb.addToPlaylist(profile.id, id(body.id), body.trackIds).catch(notFound) };
  }
  throw new ApiError(404, 'Unknown endpoint');
}
