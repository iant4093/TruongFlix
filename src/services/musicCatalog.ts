import { invoke } from '@tauri-apps/api/core';

/**
 * Browse → Music's catalogue. What's popular and new comes from the iTunes Store's public top-album
 * charts (overall and per genre, for the user's country), the mainstream charts a streaming
 * service would show. Everything exact comes from MusicBrainz: search, artists, discographies and
 * the tracklists downloads are matched and tagged against (chart albums are looked up there when
 * opened). Covers come from Apple's chart artwork and the Cover Art Archive. Requests go through
 * the app (`music_catalog`), which paces them per service and caches the answers.
 */

const MB = 'https://musicbrainz.org/ws/2';
const LB = 'https://api.listenbrainz.org/1';

export interface CatalogAlbum {
  /** MusicBrainz release group, or `itunes:<id>` for a chart album not looked up yet. */
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  /** Remote cover URL (load it through `CoverArt`). */
  cover: string | null;
  year: number | null;
  /** "Album" | "EP" | "Single" | … */
  type: string | null;
  /** YYYY-MM-DD, when the chart says. */
  released?: string | null;
}

export interface CatalogArtist {
  /** MusicBrainz artist id, or `name:<name>` for a chart artist not looked up yet. */
  id: string;
  name: string;
  /** e.g. "Group · United Kingdom". */
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
  recordingId: string | null;
  trackId: string | null;
}

/** One edition of an album, with its tracklist: what's downloaded and how it's tagged. */
export interface CatalogRelease {
  id: string;
  groupId: string;
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
  /** Other editions of the album, for the picker. */
  editions: { id: string; title: string; date: string | null; country: string | null; tracks: number | null; format: string | null }[];
}

export interface ArtistPage {
  artist: CatalogArtist & { genres: string[]; begin: string | null; type: string | null; area: string | null };
  popular: CatalogAlbum[];
  albums: CatalogAlbum[];
  eps: CatalogAlbum[];
  singles: CatalogAlbum[];
}

/** Genres, as the iTunes Store numbers them. */
export const GENRES: { id: number; label: string }[] = [
  { id: 14, label: 'Pop' },
  { id: 18, label: 'Hip-Hop' },
  { id: 21, label: 'Rock' },
  { id: 20, label: 'Alternative' },
  { id: 15, label: 'R&B' },
  { id: 6, label: 'Country' },
  { id: 17, label: 'Dance' },
  { id: 7, label: 'Electronic' },
  { id: 12, label: 'Latin' },
  { id: 10, label: 'Singer/Songwriter' },
  { id: 1153, label: 'Metal' },
  { id: 11, label: 'Jazz' },
  { id: 5, label: 'Classical' },
  { id: 16, label: 'Soundtrack' },
  { id: 51, label: 'K-Pop' },
];

type Json = Record<string, unknown>;

export const catalog = <T = Json>(url: string) => invoke<T>('music_catalog', { url });

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown) => (Array.isArray(v) ? (v as Json[]) : []);
const yearOf = (date: unknown) => {
  const y = Number(String(date ?? '').slice(0, 4));
  return y > 1000 ? y : null;
};
const label = (v: unknown) => str((v as Json | undefined)?.label);

/** A specific cover image from the Cover Art Archive (as ListenBrainz names them). */
export const caaCover = (release: unknown, caaId: unknown, size: 250 | 500 = 500) =>
  str(release) && (num(caaId) || str(caaId)) ? `https://coverartarchive.org/release/${release}/${caaId}-${size}.jpg` : null;

/** An album's chosen front cover (404 when it has none). */
export const groupCover = (groupId: string, size: 250 | 500 = 250) => `https://coverartarchive.org/release-group/${groupId}/front-${size}`;

/** "Artist & Other feat. Third", as MusicBrainz credits it. */
export function creditName(credit: unknown): string {
  return list(credit)
    .map((c) => `${str(c.name) ?? str((c.artist as Json)?.name) ?? ''}${typeof c.joinphrase === 'string' ? c.joinphrase : ''}`)
    .join('')
    .trim();
}

const firstArtistId = (credit: unknown) => str((list(credit)[0]?.artist as Json | undefined)?.id);

/** The same album appears once, however many editions or rows mention it. */
export function uniqueAlbums(albums: CatalogAlbum[]): CatalogAlbum[] {
  const seen = new Set<string>();
  return albums.filter((a) => {
    const key = albumKey(a.title, a.artist);
    if (seen.has(a.id) || seen.has(key)) return false;
    seen.add(a.id);
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Charts (iTunes Store)
// ---------------------------------------------------------------------------

/** The user's country for the charts (from the system language, e.g. en-GB → gb), else the US. */
export function chartCountry(locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language): string {
  const region = locale.split(/[-_]/)[1]?.toLowerCase();
  return region && /^[a-z]{2}$/.test(region) ? region : 'us';
}

/** "Album - EP" → ["Album", "EP"]; "Album - Single" → ["Album", "Single"]. */
function splitKind(title: string): [string, string] {
  const m = /^(.*?)\s+-\s+(EP|Single)$/i.exec(title.trim());
  return m ? [m[1], m[2].toUpperCase() === 'EP' ? 'EP' : 'Single'] : [title.trim(), 'Album'];
}

/** Chart entries from an iTunes top-albums feed, in chart order. */
export function chartFromFeed(feed: unknown): CatalogAlbum[] {
  const entries = list(((feed as Json | null)?.feed as Json | undefined)?.entry);
  return uniqueAlbums(
    entries.flatMap((e) => {
      const id = str(((e.id as Json | undefined)?.attributes as Json | undefined)?.['im:id']);
      const name = label(e['im:name']);
      const artist = label(e['im:artist']);
      if (!id || !name || !artist) return [];
      const [title, type] = splitKind(name);
      const images = list(e['im:image']);
      // The biggest thumbnail, asked for at 600px (Apple's image URLs name their size).
      const art = label(images[images.length - 1]);
      const cover = art ? art.replace(/\/\d+x\d+bb\.(png|jpg)$/, '/600x600bb.jpg') : null;
      const released = label(e['im:releaseDate'])?.slice(0, 10) ?? null;
      return [{ id: `itunes:${id}`, title, artist, artistId: null, cover, year: yearOf(released), type, released }];
    }),
  );
}

/** The top albums now, overall or in one genre. */
export async function chartAlbums(genre?: number, limit = 100): Promise<CatalogAlbum[]> {
  const country = chartCountry();
  const url = `https://itunes.apple.com/${country}/rss/topalbums/limit=${limit}${genre ? `/genre=${genre}` : ''}/json`;
  return chartFromFeed(await catalog(url));
}

/** Albums and EPs out in the last six weeks that are charting, newest first. */
export function recentFrom(charts: CatalogAlbum[][], today = new Date()): CatalogAlbum[] {
  const cutoff = new Date(today.getTime() - 42 * 86400_000).toISOString().slice(0, 10);
  const recent = uniqueAlbums(charts.flat()).filter((a) => a.released && a.released >= cutoff && a.type !== 'Single' && !/^various artists$/i.test(a.artist));
  return recent.sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''));
}

export async function newReleases(): Promise<CatalogAlbum[]> {
  const genres = [undefined, 14, 18, 21, 20, 15, 6, 17];
  const charts = await Promise.all(genres.map((g) => chartAlbums(g).catch(() => [] as CatalogAlbum[])));
  return recentFrom(charts);
}

/** The artists behind the top albums, in chart order. */
export function artistsFrom(albums: CatalogAlbum[]): CatalogArtist[] {
  const seen = new Set<string>();
  return albums.flatMap((a) => {
    // A shared credit ("A & B") counts for its first artist.
    const name = a.artist.split(/\s+(?:&|feat\.?|ft\.?|x|with)\s+|,\s*/i)[0].trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || /^(various artists|cast of|original .*cast)/i.test(name)) return [];
    seen.add(key);
    return [{ id: `name:${name}`, name }];
  });
}

export async function topArtists(): Promise<CatalogArtist[]> {
  return artistsFrom(await chartAlbums()).slice(0, 24);
}

// ---------------------------------------------------------------------------
// Matching chart entries to MusicBrainz
// ---------------------------------------------------------------------------

/** A chart title without the edition noise MusicBrainz keeps elsewhere. */
export function baseTitle(title: string): string {
  return title
    .replace(/\s*[([](?:[^)\]]*\b(?:deluxe|edition|remaster(?:ed)?|expanded|anniversary|bonus|version|explicit|clean)\b[^)\]]*)[)\]]/gi, '')
    .trim();
}

/** The MusicBrainz release group of an album (chart albums are looked up by title and artist). */
export async function resolveAlbumId(album: CatalogAlbum): Promise<string> {
  if (!album.id.startsWith('itunes:')) return album.id;
  const title = baseTitle(album.title);
  const q = `releasegroup:${phrase(title)} AND artist:${phrase(album.artist)}`;
  const data = await catalog(`${MB}/release-group?query=${encodeURIComponent(q)}&limit=10&fmt=json`);
  const hits = list((data as Json)['release-groups']).filter((g) => (num(g.score) ?? 0) >= 80);
  // An exact title match wins; then the album over a single of the same name.
  const exact = hits.find((g) => albumKey(String(g.title), '') === albumKey(title, '') && g['primary-type'] === (album.type ?? 'Album'));
  const best = exact ?? hits.find((g) => g['primary-type'] === (album.type ?? 'Album')) ?? hits[0];
  const id = str(best?.id);
  if (!id) throw new Error('MusicBrainz doesn’t have this album yet, so it can’t be downloaded with an exact tracklist.');
  return id;
}

/** The MusicBrainz id of an artist (chart artists are looked up by name). */
export async function resolveArtistId(artist: CatalogArtist): Promise<string> {
  if (!artist.id.startsWith('name:')) return artist.id;
  const data = await catalog(`${MB}/artist?query=${encodeURIComponent(`artist:${phrase(artist.name)}`)}&limit=5&fmt=json`);
  const hits = list((data as Json).artists).filter((a) => (num(a.score) ?? 0) >= 90);
  const exact = hits.find((a) => String(a.name).toLowerCase() === artist.name.toLowerCase()) ?? hits[0];
  const id = str(exact?.id);
  if (!id) throw new Error(`MusicBrainz doesn’t know ${artist.name} yet.`);
  return id;
}

// ---------------------------------------------------------------------------
// MusicBrainz: search, albums, artists
// ---------------------------------------------------------------------------

/** Quotes and escapes for MusicBrainz's search syntax. */
const phrase = (text: string) => `"${text.replace(/["\\]/g, ' ').trim()}"`;

function groupFromSearch(g: Json): CatalogAlbum | null {
  const id = str(g.id);
  const title = str(g.title);
  if (!id || !title) return null;
  return { id, title, artist: creditName(g['artist-credit']) || 'Unknown artist', artistId: firstArtistId(g['artist-credit']), cover: groupCover(id), year: yearOf(g['first-release-date']), type: str(g['primary-type']) };
}

export async function searchAlbums(query: string): Promise<CatalogAlbum[]> {
  const q = `${phrase(query)} AND (primarytype:album OR primarytype:ep) AND status:official`;
  const data = await catalog(`${MB}/release-group?query=${encodeURIComponent(q)}&limit=30&fmt=json`);
  return uniqueAlbums(list((data as Json)['release-groups']).filter((g) => (num(g.score) ?? 0) >= 60).map(groupFromSearch).filter((a): a is CatalogAlbum => !!a));
}

export async function searchArtists(query: string): Promise<CatalogArtist[]> {
  const data = await catalog(`${MB}/artist?query=${encodeURIComponent(phrase(query))}&limit=10&fmt=json`);
  return list((data as Json).artists)
    .filter((a) => (num(a.score) ?? 0) >= 70)
    .flatMap((a) => {
      const id = str(a.id);
      const name = str(a.name);
      if (!id || !name) return [];
      const detail = [str(a.type), str((a.area as Json | undefined)?.name), str(a.disambiguation)].filter(Boolean).join(' · ');
      return [{ id, name, detail }];
    });
}

export async function searchSongs(query: string): Promise<CatalogSong[]> {
  const q = `${phrase(query)} AND status:official`;
  const data = await catalog(`${MB}/recording?query=${encodeURIComponent(q)}&limit=25&fmt=json`);
  const seen = new Set<string>();
  return list((data as Json).recordings)
    .filter((r) => (num(r.score) ?? 0) >= 70)
    .flatMap((r) => {
      const id = str(r.id);
      const title = str(r.title);
      // The song's album: its first official album or EP.
      const release = list(r.releases).find((x) => ['Album', 'EP'].includes(String(((x['release-group'] as Json | undefined) ?? {})['primary-type'])));
      const group = release?.['release-group'] as Json | undefined;
      const groupId = str(group?.id);
      if (!id || !title) return [];
      const artist = creditName(r['artist-credit']) || 'Unknown artist';
      const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const album: CatalogAlbum | null = groupId
        ? { id: groupId, title: str(group?.title) ?? str(release?.title) ?? title, artist, artistId: firstArtistId(r['artist-credit']), cover: groupCover(groupId), year: yearOf(release?.date), type: str(group?.['primary-type']) }
        : null;
      return [{ id, title, artist, lengthMs: num(r.length), album }];
    });
}

interface ReleaseSummary {
  id: string;
  title: string;
  status: string | null;
  date: string | null;
  country: string | null;
  tracks: number | null;
  format: string | null;
}

/**
 * The edition to download: an official one on CD or digital, with the most common tracklist
 * length (not a deluxe box or a one-off bonus edition), released worldwide or in a big market
 * first, earliest first.
 */
export function pickEdition(releases: ReleaseSummary[]): ReleaseSummary | null {
  const official = releases.filter((r) => r.status === 'Official' || r.status == null);
  const pool = official.length ? official : releases;
  if (!pool.length) return null;
  const lengths = new Map<number, number>();
  for (const r of pool) if (r.tracks) lengths.set(r.tracks, (lengths.get(r.tracks) ?? 0) + 1);
  const common = [...lengths.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const countries = ['XW', 'US', 'GB', 'XE', 'CA', 'AU'];
  const formatRank = (f: string | null) => (f === 'Digital Media' ? 0 : f === 'CD' ? 1 : f ? 2 : 3);
  return [...pool].sort((a, b) => {
    const len = Number(b.tracks === common) - Number(a.tracks === common);
    if (len) return len;
    const fmt = formatRank(a.format) - formatRank(b.format);
    if (fmt) return fmt;
    const ca = countries.indexOf(a.country ?? '');
    const cb = countries.indexOf(b.country ?? '');
    const country = (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
    if (country) return country;
    return (a.date || '9999').localeCompare(b.date || '9999');
  })[0];
}

export function releaseFrom(data: Json, editions: CatalogRelease['editions']): CatalogRelease {
  const group = (data['release-group'] ?? {}) as Json;
  const groupId = str(group.id) ?? '';
  const tracks: CatalogTrack[] = list(data.media).flatMap((medium, m) =>
    list(medium.tracks).map((t, i) => {
      const recording = (t.recording ?? {}) as Json;
      return {
        title: str(t.title) ?? str(recording.title) ?? `Track ${i + 1}`,
        artist: creditName(t['artist-credit'] ?? recording['artist-credit']) || creditName(data['artist-credit']),
        position: num(t.position) ?? i + 1,
        disc: num(medium.position) ?? m + 1,
        lengthMs: num(t.length) ?? num(recording.length),
        recordingId: str(recording.id),
        trackId: str(t.id),
      };
    }),
  );
  const genres = [...list(data.genres), ...list(group.genres)]
    .sort((a, b) => (num(b.count) ?? 0) - (num(a.count) ?? 0))
    .map((g) => str(g.name))
    .filter((g, i, all): g is string => !!g && all.indexOf(g) === i)
    .slice(0, 4);
  const coverArt = (data['cover-art-archive'] ?? {}) as Json;
  const id = str(data.id) ?? '';
  return {
    id,
    groupId,
    title: str(data.title) ?? str(group.title) ?? 'Unknown album',
    artist: creditName(data['artist-credit']) || 'Unknown artist',
    artistId: firstArtistId(data['artist-credit']),
    date: str(data.date) ?? str(group['first-release-date']),
    year: yearOf(data.date ?? group['first-release-date']),
    type: str(group['primary-type']),
    genres,
    label: str(((list(data['label-info'])[0]?.label as Json | undefined) ?? {}).name),
    tracks,
    cover: coverArt.front ? `https://coverartarchive.org/release/${id}/front-500` : groupId ? groupCover(groupId, 500) : null,
    editions,
  };
}

/** An album's editions, and the chosen (or given) edition with its tracklist. */
export async function albumDetail(groupId: string, editionId?: string): Promise<CatalogRelease> {
  const browse = await catalog(`${MB}/release?release-group=${groupId}&inc=media&limit=100&fmt=json`);
  const editions: ReleaseSummary[] = list((browse as Json).releases).flatMap((r) => {
    const id = str(r.id);
    if (!id) return [];
    const media = list(r.media);
    const tracks = media.reduce((n, m) => n + (num(m['track-count']) ?? 0), 0) || null;
    return [{ id, title: str(r.title) ?? '', status: str(r.status), date: str(r.date), country: str(r.country), tracks, format: str(media[0]?.format) }];
  });
  const chosen = (editionId && editions.find((e) => e.id === editionId)) || pickEdition(editions);
  if (!chosen) throw new Error('MusicBrainz has no tracklist for this album yet.');
  const data = await catalog(`${MB}/release/${chosen.id}?inc=recordings+artist-credits+genres+release-groups+labels&fmt=json`);
  return releaseFrom(data as Json, editions.map(({ id, title, date, country, tracks, format }) => ({ id, title, date, country, tracks, format })));
}

export async function artistDetail(who: CatalogArtist): Promise<ArtistPage> {
  const id = await resolveArtistId(who);
  const [info, groups] = await Promise.all([
    catalog(`${MB}/artist/${id}?inc=genres&fmt=json`),
    catalog(`${MB}/release-group?artist=${id}&type=album|ep|single&limit=100&fmt=json`),
  ]);
  const popularRaw = await catalog<Json[]>(`${LB}/popularity/top-release-groups-for-artist/${id}`).catch(() => [] as Json[]);
  const a = info as Json;
  const all = list((groups as Json)['release-groups'])
    // Compilations, live albums and remixes aren't the discography people browse first.
    .filter((g) => !list(g['secondary-types']).length)
    .map(groupFromSearch)
    .filter((g): g is CatalogAlbum => !!g)
    .sort((x, y) => (y.year ?? 0) - (x.year ?? 0));
  const popular = uniqueAlbums(
    list(popularRaw).flatMap((p) => {
      const group = (p.release_group ?? {}) as Json;
      const gid = str(p.release_group_mbid);
      const title = str(group.name);
      if (!gid || !title || !['Album', 'EP'].includes(String(group.type)) || list(group.secondary_types ?? []).length) return [];
      return [{ id: gid, title, artist: str((p.artist as Json | undefined)?.name) ?? str(a.name) ?? '', artistId: id, cover: caaCover(group.caa_release_mbid, group.caa_id) ?? groupCover(gid), year: yearOf(group.date), type: str(group.type) }];
    }),
  ).slice(0, 12);
  return {
    artist: {
      id,
      name: str(a.name) ?? 'Unknown artist',
      type: str(a.type),
      area: str((a.area as Json | undefined)?.name),
      begin: str((a['life-span'] as Json | undefined)?.begin),
      genres: list(a.genres).sort((x, y) => (num(y.count) ?? 0) - (num(x.count) ?? 0)).map((g) => str(g.name)).filter((g): g is string => !!g).slice(0, 5),
    },
    popular,
    albums: all.filter((g) => g.type === 'Album'),
    eps: all.filter((g) => g.type === 'EP'),
    singles: all.filter((g) => g.type === 'Single'),
  };
}

// ---------------------------------------------------------------------------
// Library matching
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Keys an album by its title and artist, the way the library and the catalogue can both name it. */
export const albumKey = (title: string, artist: string) => `${norm(title)}|${norm(artist)}`;
