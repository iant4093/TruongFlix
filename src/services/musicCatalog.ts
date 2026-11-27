import { invoke } from '@tauri-apps/api/core';

/**
 * Browse → Music's catalogue, all from Apple's public data: Apple Music's most-played charts (what
 * people are actually streaming), and the iTunes Search API for search, artists' discographies and
 * album tracklists. Each album is one specific release, with exact track titles, numbers, discs and
 * lengths, which is what downloads are matched against and tagged with. Covers and artist photos
 * come straight from Apple's image CDN. Requests go through the app (`music_catalog`), which paces
 * searches and caches answers.
 */

export interface CatalogAlbum {
  /** iTunes collection id. */
  id: string;
  title: string;
  artist: string;
  /** iTunes artist id. */
  artistId: string | null;
  /** Cover URL (resized with `sizedCover`). */
  cover: string | null;
  year: number | null;
  /** "Album" | "EP" | "Single" */
  type: string | null;
  /** YYYY-MM-DD, when known. */
  released?: string | null;
  explicit?: boolean;
  /** Genre names, as the store gives them. */
  genres?: string[];
}

export interface CatalogArtist {
  /** iTunes artist id. */
  id: string;
  name: string;
  /** e.g. "Alternative". */
  detail?: string;
}

export interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  lengthMs: number | null;
  album: CatalogAlbum | null;
}

export interface CatalogTrack {
  title: string;
  artist: string;
  position: number;
  disc: number;
  lengthMs: number | null;
}

/** An album with its tracklist: what's downloaded and how it's tagged. */
export interface CatalogRelease {
  /** `itunes:<collection id>`. */
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  date: string | null;
  year: number | null;
  type: string | null;
  genres: string[];
  label: string | null;
  tracks: CatalogTrack[];
  cover: string | null;
  explicit: boolean;
}

export interface ArtistPage {
  artist: CatalogArtist & { genre: string | null };
  popular: CatalogAlbum[];
  albums: CatalogAlbum[];
  eps: CatalogAlbum[];
  singles: CatalogAlbum[];
}


type Json = Record<string, unknown>;

const inflight = new Map<string, Promise<unknown>>();
/**
 * One request per URL at a time: rows that need the same chart share it. `background` requests
 * (an import matching its songs) wait in their own lane, so browsing never waits behind them.
 */
export function catalog<T = Json>(url: string, background = false): Promise<T> {
  let job = inflight.get(url) as Promise<T> | undefined;
  if (!job) {
    job = invoke<T>('music_catalog', { url, background }).finally(() => inflight.delete(url));
    inflight.set(url, job);
  }
  return job;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown) => (Array.isArray(v) ? (v as Json[]) : []);
const yearOf = (date: unknown) => {
  const y = Number(String(date ?? '').slice(0, 4));
  return y > 1000 ? y : null;
};

/** Apple's artwork at `px` pixels square (its image URLs name their size and crop). */
export function sizedCover(url: string | null, px: number): string | null {
  if (!url) return null;
  const sized = /\/\d+x\d+(bb|cw|cc)\.(png|jpe?g|webp)$/;
  return sized.test(url) ? url.replace(sized, (_, crop: string) => `/${px}x${px}${crop === 'cw' ? 'cc' : crop}.jpg`) : url;
}

/** The user's country for the store (from the system language, e.g. en-GB → gb), else the US. */
export function chartCountry(locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language): string {
  const region = locale.split(/[-_]/)[1]?.toLowerCase();
  return region && /^[a-z]{2}$/.test(region) ? region : 'us';
}

/** "Album - EP" → ["Album", "EP"]; "Album - Single" → ["Album", "Single"]. */
function splitKind(title: string): [string, string] {
  const m = /^(.*?)\s+-\s+(EP|Single)$/i.exec(title.trim());
  return m ? [m[1], m[2].toUpperCase() === 'EP' ? 'EP' : 'Single'] : [title.trim(), 'Album'];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Keys an album by its title and artist, the way the library and the catalogue can both name it. */
export const albumKey = (title: string, artist: string) => `${norm(title)}|${norm(artist)}`;

/**
 * Each album once, in the order first seen: the store lists clean and explicit releases (and
 * chart rows) separately. The explicit release is kept, as that's what people share.
 */
export function uniqueAlbums(albums: CatalogAlbum[]): CatalogAlbum[] {
  const chosen = new Map<string, CatalogAlbum>();
  const order: string[] = [];
  for (const a of albums) {
    const key = albumKey(a.title, a.artist);
    const seen = chosen.get(key);
    if (!seen) order.push(key);
    if (!seen || (a.explicit && !seen.explicit)) chosen.set(key, a);
  }
  return order.map((key) => chosen.get(key)!);
}

// ---------------------------------------------------------------------------
// Charts (Apple Music's most played)
// ---------------------------------------------------------------------------

const FEEDS = 'https://rss.marketingtools.apple.com/api/v2';

/** The numeric id at the end of a store link (".../album/name/1097861387?i=1097861390"). */
export const idFromLink = (href: unknown) => /\/(?:id)?(\d+)(?:\?|$)/.exec(String(href ?? ''))?.[1] ?? null;

const genreNames = (r: Json) => list(r.genres).map((g) => str(g.name)).filter((g): g is string => !!g && g !== 'Music');

/** Albums from a most-played albums feed, in chart order. */
export function feedAlbums(feed: unknown): CatalogAlbum[] {
  const rows = list(((feed as Json | null)?.feed as Json | undefined)?.results);
  return uniqueAlbums(
    rows.flatMap((r) => {
      const id = str(r.id);
      const name = str(r.name);
      if (!id || !name) return [];
      const [title, type] = splitKind(name);
      const released = str(r.releaseDate)?.slice(0, 10) ?? null;
      return [{
        id,
        title,
        artist: str(r.artistName) ?? 'Unknown artist',
        artistId: str(r.artistId),
        cover: sizedCover(str(r.artworkUrl100), 600),
        year: yearOf(released),
        type,
        released,
        explicit: r.contentAdvisoryRating === 'Explict' || r.contentAdvisoryRating === 'Explicit',
        genres: genreNames(r),
      }];
    }),
  );
}

/** The albums behind a most-played songs feed: album id and genres, in chart order. */
export function feedSongAlbums(feed: unknown): { id: string; genres: string[] }[] {
  const rows = list(((feed as Json | null)?.feed as Json | undefined)?.results);
  return rows.flatMap((r) => {
    const id = /\/album\/[^/]*\/(\d+)/.exec(String(r.url ?? ''))?.[1];
    return id ? [{ id, genres: genreNames(r) }] : [];
  });
}

const mostPlayed = (country: string, kind: 'albums' | 'songs') => catalog(`${FEEDS}/${country}/music/most-played/100/${kind}.json`);

/** Resolves to null after `ms`: a feed that stalls never holds the page up. */
const within = <T,>(job: Promise<T>, ms: number) => Promise.race([job.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/**
 * What's most played right now in the user's country. A request the CDN leaves hanging is
 * abandoned after a few seconds and asked again once; then the multi-country pool stands in.
 */
export async function topAlbums(): Promise<CatalogAlbum[]> {
  const url = `${FEEDS}/${chartCountry()}/music/most-played/100/albums.json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const albums = feedAlbums(await within(catalog(url), 4500));
    if (albums.length) return albums;
    inflight.delete(url);
  }
  const pool = await chartPool();
  if (!pool.length) throw new Error('Apple Music’s charts couldn’t be reached.');
  return pool;
}

/** Countries whose charts fill the genre rows (big English-language markets, plus the user's). */
const POOL_COUNTRIES = ['us', 'gb', 'ca', 'au'];

/**
 * Albums people are streaming most, ranked by how high they and their songs chart in the user's
 * country and the big English-language markets; each carries the genres its chart entries name.
 */
export async function chartPool(): Promise<CatalogAlbum[]> {
  const countries = [...new Set([chartCountry(), ...POOL_COUNTRIES])];
  // Every feed at once; one that's slow to answer (Apple's CDN sometimes stalls) is left out.
  const feeds = await Promise.all(
    countries.map(async (cc) => {
      const [albums, songs] = await Promise.all([within(mostPlayed(cc, 'albums'), 4000), within(mostPlayed(cc, 'songs'), 4000)]);
      return { cc, albums: feedAlbums(albums), songs: feedSongAlbums(songs) };
    }),
  );
  if (!feeds.some((f) => f.albums.length || f.songs.length)) throw new Error('Apple Music’s charts couldn’t be reached.');
  const score = new Map<string, number>();
  const genres = new Map<string, Set<string>>();
  const known = new Map<string, CatalogAlbum>();
  const add = (id: string, rank: number, names: string[]) => {
    score.set(id, (score.get(id) ?? 0) + (101 - Math.min(rank, 100)));
    const set = genres.get(id) ?? new Set<string>();
    names.forEach((g) => set.add(g));
    genres.set(id, set);
  };
  for (const feed of feeds) {
    feed.albums.forEach((a, i) => {
      known.set(a.id, known.get(a.id) ?? a);
      add(a.id, i + 1, a.genres ?? []);
    });
    feed.songs.forEach((s, i) => add(s.id, i + 1, s.genres));
  }
  // Albums known only from their songs are looked up together, 50 at a time (the store's limit
  // for one lookup), most played first.
  const missing = [...new Set(feeds.flatMap((f) => f.songs.map((s) => s.id)))]
    .filter((id) => !known.has(id))
    .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
    .slice(0, 200);
  const batches = Array.from({ length: Math.ceil(missing.length / 50) }, (_, i) => missing.slice(i * 50, i * 50 + 50));
  const answers = await Promise.all(batches.map((ids) => within(catalog(`${API}/lookup?id=${ids.join(',')}&country=${chartCountry()}`), 8000)));
  for (const data of answers) {
    for (const r of list((data as Json | null)?.results)) {
      const album = r.wrapperType === 'collection' ? albumFrom(r) : null;
      if (album && !known.has(album.id)) known.set(album.id, { ...album, genres: [str(r.primaryGenreName)].filter((g): g is string => !!g) });
    }
  }
  const ranked = [...known.values()]
    .map((a) => ({ ...a, genres: [...new Set([...(genres.get(a.id) ?? []), ...(a.genres ?? [])])] }))
    .sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
  return uniqueAlbums(ranked);
}

/** Genres as chips, each matching the store's genre names; only those with enough music show. */
export const GENRES: { key: string; label: string; names: string[] }[] = [
  { key: 'pop', label: 'Pop', names: ['Pop', 'K-Pop', 'Pop Latino'] },
  { key: 'hiphop', label: 'Hip-Hop', names: ['Hip-Hop/Rap', 'Hip-Hop', 'Rap', 'UK Hip-Hop', 'Drill', 'Trap'] },
  { key: 'rnb', label: 'R&B', names: ['R&B/Soul', 'Soul', 'Contemporary R&B'] },
  { key: 'country', label: 'Country', names: ['Country', 'Contemporary Country'] },
  { key: 'alternative', label: 'Alternative', names: ['Alternative', 'Indie Rock', 'Indie Pop'] },
  { key: 'rock', label: 'Rock', names: ['Rock', 'Hard Rock', 'Metal', 'Punk', 'Classic Rock'] },
  { key: 'latin', label: 'Latin', names: ['Latin', 'Urbano latino', 'Música Mexicana', 'Regional Mexicano', 'Pop Latino', 'Reggaeton'] },
  { key: 'dance', label: 'Dance & Electronic', names: ['Dance', 'Electronic', 'House', 'Techno', 'Electronica'] },
  { key: 'kpop', label: 'K-Pop', names: ['K-Pop'] },
  { key: 'singer', label: 'Singer/Songwriter', names: ['Singer/Songwriter', 'Folk'] },
  { key: 'soundtrack', label: 'Soundtracks', names: ['Soundtrack', 'Original Score'] },
  { key: 'holiday', label: 'Holiday', names: ['Holiday', 'Christmas', 'Christmas: Pop'] },
];

export const inGenre = (album: CatalogAlbum, key: string) => {
  const genre = GENRES.find((g) => g.key === key);
  return !!genre && (album.genres ?? []).some((g) => genre.names.includes(g));
};

/** The genres with enough charting albums to fill a row. */
export const genresIn = (pool: CatalogAlbum[], min = 6) => GENRES.filter((g) => pool.filter((a) => inGenre(a, g.key)).length >= min);

/** Albums and EPs out in the last six weeks, most played first. */
export function recentFrom(pool: CatalogAlbum[], today = new Date()): CatalogAlbum[] {
  const cutoff = new Date(today.getTime() - 42 * 86400_000).toISOString().slice(0, 10);
  return pool.filter((a) => a.released && a.released >= cutoff && a.type !== 'Single' && !/^various artists$/i.test(a.artist));
}

/** The artists behind the most played albums, in order. */
export function artistsFrom(albums: CatalogAlbum[]): CatalogArtist[] {
  const seen = new Set<string>();
  return albums.flatMap((a) => {
    const name = a.artist.split(/\s+(?:&|feat\.?|ft\.?|x|with)\s+|,\s*/i)[0].trim();
    const key = name.toLowerCase();
    if (!a.artistId || !name || seen.has(key) || seen.has(a.artistId) || /^(various artists|cast of|original .*cast)/i.test(name)) return [];
    seen.add(key);
    seen.add(a.artistId);
    return [{ id: a.artistId, name }];
  });
}

// ---------------------------------------------------------------------------
// Search, albums and artists (iTunes Search API)
// ---------------------------------------------------------------------------

const API = 'https://itunes.apple.com';

/** An album from a search or lookup result. */
export function albumFrom(r: Json): CatalogAlbum | null {
  const id = str(r.collectionId);
  const name = str(r.collectionName);
  if (!id || !name) return null;
  const [title, kind] = splitKind(name);
  const tracks = num(r.trackCount);
  // The store marks EPs and singles in the title; very short releases without one are singles.
  const type = kind !== 'Album' ? kind : tracks != null && tracks <= 2 ? 'Single' : 'Album';
  const released = str(r.releaseDate)?.slice(0, 10) ?? null;
  return {
    id,
    title,
    artist: str(r.artistName) ?? 'Unknown artist',
    artistId: str(r.artistId),
    cover: sizedCover(str(r.artworkUrl100), 600),
    year: yearOf(released),
    type,
    released,
    explicit: r.collectionExplicitness === 'explicit',
  };
}

export async function searchMusic(query: string): Promise<{ albums: CatalogAlbum[]; artists: CatalogArtist[]; songs: CatalogSong[] }> {
  const term = encodeURIComponent(query.trim());
  const country = chartCountry();
  const [albumData, songData] = await Promise.all([
    catalog(`${API}/search?term=${term}&media=music&entity=album&limit=50&country=${country}`),
    catalog(`${API}/search?term=${term}&media=music&entity=song&limit=40&country=${country}`),
  ]);
  const albumRows = list((albumData as Json | null)?.results);
  const songRows = list((songData as Json | null)?.results).filter((r) => r.wrapperType === 'track' && r.kind === 'song');
  const albums = uniqueAlbums(albumRows.map(albumFrom).filter((a): a is CatalogAlbum => !!a));
  const seen = new Set<string>();
  const songs: CatalogSong[] = songRows.flatMap((r) => {
    const id = str(r.trackId);
    const title = str(r.trackName);
    const artist = str(r.artistName) ?? 'Unknown artist';
    const key = `${title?.toLowerCase()}|${artist.toLowerCase()}`;
    if (!id || !title || seen.has(key)) return [];
    seen.add(key);
    return [{ id, title, artist, lengthMs: num(r.trackTimeMillis), album: albumFrom(r) }];
  });
  // Artists whose name matches what was typed, as they appear in the results.
  const words = norm(query).split(' ').filter(Boolean);
  const artists = new Map<string, CatalogArtist>();
  for (const r of [...albumRows, ...songRows]) {
    const id = str(r.artistId);
    const name = str(r.artistName);
    if (!id || !name || artists.has(id) || /^various artists$/i.test(name)) continue;
    const nameWords = norm(name).split(' ');
    if (words.length && words.every((w) => nameWords.some((n) => n.startsWith(w)))) artists.set(id, { id, name, detail: str(r.primaryGenreName) ?? undefined });
  }
  return { albums, artists: [...artists.values()].slice(0, 10), songs };
}

/** "℗ 1997 XL Recordings Ltd" → "XL Recordings Ltd". */
export function labelFrom(copyright: unknown): string | null {
  const text = str(copyright);
  if (!text) return null;
  const cleaned = text
    .replace(/^(?:[℗©]|\([cCpP]\))\s*/, '')
    .replace(/^\d{4}(?:\s*[-,]\s*\d{4})*\s*/, '')
    .trim();
  return cleaned || null;
}

/** An album and its tracklist from an iTunes lookup. */
export function releaseFrom(lookup: unknown): CatalogRelease {
  const rows = list((lookup as Json | null)?.results);
  const collection = rows.find((r) => r.wrapperType === 'collection');
  const album = collection && albumFrom(collection);
  if (!collection || !album) throw new Error('This album isn’t in the store any more.');
  const tracks: CatalogTrack[] = rows
    .filter((r) => r.wrapperType === 'track' && (r.kind === 'song' || r.kind == null))
    .map((r) => ({
      title: str(r.trackName) ?? 'Untitled',
      artist: str(r.artistName) ?? album.artist,
      position: num(r.trackNumber) ?? 0,
      disc: num(r.discNumber) ?? 1,
      lengthMs: num(r.trackTimeMillis),
    }))
    .filter((t) => t.position > 0)
    .sort((a, b) => a.disc - b.disc || a.position - b.position);
  return {
    id: `itunes:${album.id}`,
    title: album.title,
    artist: album.artist,
    artistId: album.artistId,
    date: album.released ?? null,
    year: album.year,
    type: album.type,
    genres: [str(collection.primaryGenreName)].filter((g): g is string => !!g && g !== 'Music'),
    label: labelFrom(collection.copyright),
    tracks,
    cover: album.cover,
    explicit: !!album.explicit,
  };
}

export async function albumDetail(id: string): Promise<CatalogRelease> {
  const release = releaseFrom(await catalog(`${API}/lookup?id=${encodeURIComponent(id)}&entity=song&limit=200&country=${chartCountry()}`));
  if (!release.tracks.length) throw new Error('The store doesn’t list this album’s songs, so it can’t be downloaded.');
  return release;
}

export async function artistDetail(who: CatalogArtist): Promise<ArtistPage> {
  const data = await catalog(`${API}/lookup?id=${encodeURIComponent(who.id)}&entity=album&limit=200&country=${chartCountry()}`);
  const rows = list((data as Json | null)?.results);
  const info = rows.find((r) => r.wrapperType === 'artist');
  // The store lists an artist's albums most popular first.
  const all = uniqueAlbums(rows.filter((r) => r.wrapperType === 'collection').map(albumFrom).filter((a): a is CatalogAlbum => !!a));
  const byDate = (items: CatalogAlbum[]) => [...items].sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''));
  return {
    artist: { id: who.id, name: str(info?.artistName) ?? who.name, genre: str(info?.primaryGenreName) },
    popular: all.filter((a) => a.type !== 'Single').slice(0, 12),
    albums: byDate(all.filter((a) => a.type === 'Album')),
    eps: byDate(all.filter((a) => a.type === 'EP')),
    singles: byDate(all.filter((a) => a.type === 'Single')),
  };
}

const photos = new Map<string, Promise<string | null>>();
/** An artist's photo from their Apple Music page (null when they have none, or for now). */
export function artistPhoto(id: string): Promise<string | null> {
  let job = photos.get(id);
  if (!job) {
    job = invoke<string | null>('music_artist_photo', { id, country: chartCountry() }).catch(() => {
      // Not remembered: the next time this artist shows, it's asked for again.
      photos.delete(id);
      return null;
    });
    photos.set(id, job);
  }
  return job;
}
