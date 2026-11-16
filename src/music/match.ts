/**
 * How songs become albums and artists. Tags win; when they're missing, the file name and folders
 * fill in (`Artist/Album (Year)/01 - Title.flac`, `CD2` sub-folders, `Artist - Title.mp3`), featured
 * artists don't split an album, and per-disc album names ("Album (Disc 2)") join one album.
 */

export interface TagFields {
  file_path: string;
  title: string | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
}

export const VARIOUS_ARTISTS = 'Various Artists';

const SEP = /[\\/]/;
/** Curly quotes and dashes made plain, spacing collapsed. */
const tidy = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const fold = (s: string) => tidy(s).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Artist key: case, accents, spacing and a leading "The" don't matter ("Beyoncé" = "beyonce", "The Beatles" = "Beatles"). */
export function nameKey(name: string): string {
  return fold(name).replace(/^the\s+(?=\S)/, '');
}

/** Album key: case, accents and spacing don't matter. */
export function albumKey(title: string): string {
  return fold(title);
}

/** "Artist feat. Guest" → "Artist". Bands with "&" or "and" in their name are left alone. */
export function primaryArtist(name: string): string {
  const first = tidy(name).split(/\s*;\s*|\u0000/)[0];
  const main = first.split(/\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+/i)[0];
  return tidy(main.replace(/[([]\s*$/, '')) || tidy(first);
}

const DISC_SUFFIX = /\s*(?:[([]\s*)?(?:-\s*)?\b(?:cd|disc|disk)\s*(\d{1,2})(?:\s*(?:of|\/)\s*\d{1,2})?\s*[)\]]?\s*$/i;

/** "Album (Disc 2)" → { album: "Album", disc: 2 }. */
export function splitDisc(album: string): { album: string; disc: number | null } {
  const m = album.match(DISC_SUFFIX);
  if (!m || m.index === 0) return { album: tidy(album), disc: null };
  return { album: tidy(album.slice(0, m.index)), disc: Number(m[1]) || null };
}

/** Folder names like "CD1", "Disc 2", "Disk 03". */
const DISC_FOLDER = /^(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})$/i;

/** Release-group noise in folder names: "[FLAC]", "{24-96}", "(2019)", "WEB", "320kbps"… */
function cleanFolder(name: string): { name: string; year: number | null } {
  let year: number | null = null;
  let s = name.replace(/_/g, ' ');
  const y = s.match(/[([]\s*((?:19|20)\d{2})\s*[)\]]/);
  if (y) year = Number(y[1]);
  s = s.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  s = s.replace(/\b(?:flac|mp3|aac|alac|ogg|opus|wav|web|cd|vinyl|lossless|hi-?res|\d{2,3}\s?kbps|\d{2}-\d{2,3}|24bit|16bit|v0|v2|320)\b/gi, ' ');
  s = tidy(s).replace(/^[-–\s.]+|[-–\s.]+$/g, '');
  return { name: s, year };
}

export interface PathGuess {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
}

/** Reads what it can from the path. `roots` are the music folders (never used as an artist name). */
export function guessFromPath(path: string, roots: string[] = []): PathGuess {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const parts = path.split(SEP).filter(Boolean);
  const file = parts.pop() ?? path;
  // A folder at or above a music folder is never an album or artist name.
  const rootKeys = roots.map((r) => norm(r).replace(/^\//, '')).filter(Boolean);
  const isRoot = (index: number) => {
    const p = norm(parts.slice(0, index + 1).join('/')).replace(/^\//, '');
    return rootKeys.some((r) => r === p || r.startsWith(`${p}/`));
  };
  const out: PathGuess = { title: null, artist: null, album: null, albumArtist: null, trackNo: null, discNo: null, year: null };

  // File name: "1-03 Title", "03 - Artist - Title", "03. Title", "Artist - Title".
  let stem = tidy(file.replace(/\.[^.]+$/, '').replace(/_/g, ' '));
  const discTrack = stem.match(/^(\d{1,2})[-.](\d{1,3})(?:\s*[-.]\s*|\s+)(.+)$/);
  const track = stem.match(/^(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/);
  if (discTrack && Number(discTrack[1]) <= 20) {
    out.discNo = Number(discTrack[1]);
    out.trackNo = Number(discTrack[2]);
    stem = discTrack[3];
  } else if (track && !/^\d{4}\b/.test(stem)) {
    out.trackNo = Number(track[1]);
    stem = track[2];
  }
  const dash = stem.split(/\s+-\s+/);
  if (dash.length >= 2) {
    out.artist = tidy(dash[0]);
    out.title = tidy(dash.slice(1).join(' - '));
  } else out.title = stem || null;

  // Folders: [.../Artist]/Album[/CD1]/file
  let i = parts.length - 1;
  if (i >= 0 && !isRoot(i)) {
    const disc = parts[i].match(DISC_FOLDER);
    if (disc) {
      out.discNo ??= Number(disc[1]);
      i--;
    }
  }
  if (i >= 0 && !isRoot(i)) {
    const { name, year } = cleanFolder(parts[i]);
    out.year = year;
    const pair = name.split(/\s+-\s+/);
    if (pair.length >= 2) {
      out.albumArtist = tidy(pair[0]);
      out.album = tidy(pair.slice(1).join(' - '));
    } else out.album = name || null;
    i--;
  }
  if (!out.albumArtist && i >= 0 && !isRoot(i)) {
    const { name } = cleanFolder(parts[i]);
    if (name) out.albumArtist = name;
  }
  return out;
}

/** The folder holding an album (the parent of a CD1/Disc 2 folder). */
export function albumFolder(path: string): string {
  const parts = path.split(SEP);
  parts.pop();
  if (parts.length && DISC_FOLDER.test(parts[parts.length - 1])) parts.pop();
  return parts.join('/').toLowerCase();
}

export interface ResolvedTags {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
}

/** Tags first, the path for anything missing. Album artist is settled later by `settleAlbumArtists`. */
export function resolveTags(f: TagFields, roots: string[] = []): ResolvedTags & { albumArtistTagged: boolean } {
  const guess = guessFromPath(f.file_path, roots);
  const artist = tidy(f.artist ?? '') || tidy(f.album_artist ?? '') || guess.artist || guess.albumArtist || 'Unknown Artist';
  const rawAlbum = tidy(f.album ?? '') || guess.album || 'Unknown Album';
  const { album, disc } = splitDisc(rawAlbum);
  return {
    title: tidy(f.title ?? '') || guess.title || 'Untitled',
    artist,
    albumArtist: tidy(f.album_artist ?? ''),
    albumArtistTagged: !!tidy(f.album_artist ?? ''),
    album: album || rawAlbum,
    trackNo: f.track_no ?? guess.trackNo,
    discNo: f.disc_no ?? disc ?? guess.discNo,
    year: f.year ?? guess.year,
  };
}

/**
 * Album artist for songs without one: the album's main artist (featured guests ignored), or
 * "Various Artists" when no single artist has most of the songs. `others` are artists of songs
 * already in the library from the same album folder.
 */
export function settleAlbumArtist(artists: string[], others: string[] = [], folderArtist: string | null = null): string {
  const all = [...artists, ...others].map(primaryArtist).filter(Boolean);
  if (!all.length) return folderArtist || 'Unknown Artist';
  const counts = new Map<string, { name: string; n: number }>();
  for (const a of all) {
    const k = nameKey(a);
    const hit = counts.get(k);
    if (hit) hit.n++;
    else counts.set(k, { name: a, n: 1 });
  }
  if (counts.size === 1) return [...counts.values()][0].name;
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (top.n / all.length > 0.5) return top.name;
  if (folderArtist && counts.has(nameKey(folderArtist))) return counts.get(nameKey(folderArtist))!.name;
  return VARIOUS_ARTISTS;
}
