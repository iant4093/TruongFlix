import type { MusicAlbum, MusicArtist, MusicLibrary, MusicPlaylist, MusicTrack } from './types';

const byDiscTrack = (a: MusicTrack, b: MusicTrack) =>
  (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 9999) - (b.trackNo ?? 9999) || a.title.localeCompare(b.title);

/** Sort key that ignores a leading "The " and case. */
export const sortKey = (s: string) => s.replace(/^the\s+/i, '').toLocaleLowerCase();
export const byName = (a: string, b: string) => sortKey(a).localeCompare(sortKey(b));

/** Albums and artists from the songs (album/artist ids come from the database). */
export function assembleLibrary(tracks: MusicTrack[], playlists: MusicPlaylist[]): MusicLibrary {
  const albums = new Map<number, MusicAlbum>();
  const artists = new Map<number, MusicArtist & { albums: Set<number> }>();
  const sorted = [...tracks].sort(byDiscTrack);
  for (const t of sorted) {
    let al = albums.get(t.albumId);
    if (!al) {
      al = { id: t.albumId, title: t.album, artist: t.albumArtist, artistId: t.albumArtistId, year: t.year, genre: t.genre, art: t.art, trackIds: [], duration: 0, addedAt: t.addedAt, lastPlayed: null, plays: 0 };
      albums.set(t.albumId, al);
    }
    al.trackIds.push(t.id);
    al.duration += t.duration;
    al.art ??= t.art;
    al.year ??= t.year;
    al.genre ??= t.genre;
    al.addedAt = Math.min(al.addedAt, t.addedAt);
    al.plays += t.plays;
    if (t.lastPlayed && (!al.lastPlayed || t.lastPlayed > al.lastPlayed)) al.lastPlayed = t.lastPlayed;

    const people: [number, string, boolean][] = [[t.albumArtistId, t.albumArtist, true]];
    if (t.artistId !== t.albumArtistId) people.push([t.artistId, t.artist, false]);
    for (const [id, name, albumArtist] of people) {
      let ar = artists.get(id);
      if (!ar) {
        ar = { id, name, art: null, albumIds: [], trackCount: 0, albums: new Set() };
        artists.set(id, ar);
      }
      ar.trackCount++;
      if (albumArtist) {
        ar.albums.add(t.albumId);
        ar.art ??= t.art;
      } else ar.art ??= t.art;
    }
  }
  const albumList = [...albums.values()].sort((a, b) => byName(a.title, b.title));
  const artistList = [...artists.values()]
    .map(({ albums: set, ...a }) => ({ ...a, albumIds: albumList.filter((al) => set.has(al.id)).sort((x, y) => (y.year ?? 0) - (x.year ?? 0)).map((al) => al.id) }))
    .sort((a, b) => byName(a.name, b.name));
  return {
    tracks: [...tracks].sort((a, b) => byName(a.title, b.title)),
    albums: albumList,
    artists: artistList,
    playlists: [...playlists].sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

export interface ListenNow {
  recent: MusicAlbum[];
  top: MusicAlbum[];
  added: MusicAlbum[];
  topSongs: MusicTrack[];
}

export function listenNow(lib: MusicLibrary): ListenNow {
  const albums = lib.albums;
  return {
    recent: albums.filter((a) => a.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)).slice(0, 12),
    top: albums.filter((a) => a.plays > 0).sort((a, b) => b.plays - a.plays || byName(a.title, b.title)).slice(0, 12),
    added: [...albums].sort((a, b) => b.addedAt - a.addedAt).slice(0, 12),
    topSongs: lib.tracks.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, 10),
  };
}

export interface MusicSearch {
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
}

const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();

/** Every word must appear in the song's title, artist or album (accents ignored). */
export function searchMusic(lib: MusicLibrary, query: string, limit = 50): MusicSearch {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { tracks: [], albums: [], artists: [] };
  const hit = (...fields: (string | null)[]) => {
    const hay = fold(fields.filter(Boolean).join(' '));
    return words.every((w) => hay.includes(w));
  };
  return {
    tracks: lib.tracks.filter((t) => hit(t.title, t.artist, t.album)).slice(0, limit),
    albums: lib.albums.filter((a) => hit(a.title, a.artist)).slice(0, limit),
    artists: lib.artists.filter((a) => hit(a.name)).slice(0, limit),
  };
}

/** Up to four distinct covers for a playlist's mosaic. */
export function playlistArt(byId: Map<number, MusicTrack>, playlist: MusicPlaylist): string[] {
  const out: string[] = [];
  for (const id of playlist.trackIds) {
    const art = byId.get(id)?.art;
    if (art && !out.includes(art)) out.push(art);
    if (out.length === 4) break;
  }
  return out;
}

export function formatTime(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatTotal(s: number) {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? `, ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}
