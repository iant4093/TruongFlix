import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Check, ChevronDown, Download, Folder, Loader2, Music2, Search } from 'lucide-react';
import { useLibraryStore } from '../../../store/useLibraryStore';
import type { CatalogRelease } from '../../../services/musicCatalog';
import { downloadAlbum, downloadSharedFolder, folderName, pathInFolder, searchSoulseek, type SharedFileHit, type SharedFolder, type SoulseekSearchUpdate } from '../../../services/musicDownloads';
import { coreTitle, pickSongFile } from '../../../services/playlistImport';
import { errorMessage } from '../../../lib/errors';
import Dialog from '../../common/Dialog';
import SegmentedControl from '../../common/SegmentedControl';

type FormatFilter = 'all' | 'flac' | 'mp3';

const FILTERS = [
  { value: 'all' as const, label: 'All formats' },
  { value: 'flac' as const, label: 'FLAC' },
  { value: 'mp3' as const, label: 'MP3' },
];

const megabytes = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const clock = (secs: number | null) => (secs == null ? '' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);

/** "FLAC 24-bit", "MP3 320", "M4A". */
export function formatLabel(folder: SharedFolder) {
  const sample = folder.files.find((f) => f.path.toLowerCase().endsWith(`.${folder.format}`));
  const name = folder.format.toUpperCase();
  if (folder.format === 'flac') return sample?.bitDepth && sample.bitDepth > 16 ? `${name} ${sample.bitDepth}-bit` : name;
  if (folder.format === 'mp3' && sample?.bitrate) return `${name} ${sample.bitrate}`;
  return name;
}

/** The search to start with for an album: its artist and title without edition notes. */
export function albumQuery(release: CatalogRelease) {
  const title = release.title.split(/[([]/)[0].replace(/\s+-\s+(EP|Single)$/i, '').trim();
  const artist = /^various( artists)?$/i.test(release.artist.trim()) ? '' : release.artist;
  return `${artist} ${title}`.replace(/[^\p{L}\p{N}'&]+/gu, ' ').trim();
}

/** A playlist song being found by hand. */
export interface SongTarget {
  importId: string;
  key: string;
  title: string;
  artists: string[];
  album: string | null;
  lengthMs: number | null;
}

/** The search to start with for a song: its main artist and its title's own words. */
export function songQuery(song: Pick<SongTarget, 'title' | 'artists'>) {
  const artist = song.artists[0] ?? '';
  return `${artist} ${coreTitle(song.title)}`.replace(/[^\p{L}\p{N}'&]+/gu, ' ').trim();
}

/** "FLAC 24-bit", "MP3 320" for one file. */
function fileFormat(file: SharedFileHit) {
  const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'flac') return file.bitDepth && file.bitDepth > 16 ? `FLAC ${file.bitDepth}-bit` : 'FLAC';
  if (ext === 'mp3' && file.bitrate) return `MP3 ${file.bitrate}`;
  return ext.toUpperCase();
}

/**
 * Searching Soulseek by hand: every shared folder that answers, with its format, size and
 * whether its owner can send right away. For an album, folders with all its songs come first and
 * download as that album (checked, tagged and filed); any other folder downloads as it is.
 */
export default function SoulseekSearchDialog({ release, song = null, onClose, onStarted }: { release: CatalogRelease | null; song?: SongTarget | null; onClose: () => void; onStarted?: () => void }) {
  const [query, setQuery] = useState(() => (song ? songQuery(song) : release ? albumQuery(release) : ''));
  const [result, setResult] = useState<SoulseekSearchUpdate | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FormatFilter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const total = release?.tracks.length ?? 0;

  const run = async (text: string) => {
    stop.current?.();
    stop.current = null;
    if (!text.trim()) return;
    setError('');
    setResult(null);
    setOpen(null);
    setSearching(true);
    try {
      stop.current = await searchSoulseek(
        text.trim(),
        release,
        (update) => {
          setResult(update);
          if (update.done) setSearching(false);
        },
        song && { title: song.title, artists: song.artists, album: song.album, lengthMs: song.lengthMs },
      );
    } catch (e) {
      setSearching(false);
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    // An album's or a song's search starts by itself; otherwise there's nothing to search for yet.
    if (release || song) void run(query);
    else input.current?.focus();
    return () => stop.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const folders = useMemo(() => (result?.folders ?? []).filter((f) => filter === 'all' || f.format === filter), [result, filter]);

  const files = useMemo(() => (result?.files ?? []).filter((f) => filter === 'all' || f.path.toLowerCase().endsWith(`.${filter}`)), [result, filter]);

  const pickFile = async (file: SharedFileHit) => {
    if (!song) return;
    const key = `${file.user}\n${file.path}`;
    setStarting(key);
    setError('');
    try {
      await pickSongFile(song.importId, song.key, { user: file.user, path: file.path, size: file.size, bitrate: file.bitrate, duration: file.duration, bitDepth: file.bitDepth });
      stop.current?.();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(null);
    }
  };

  const download = async (folder: SharedFolder, asAlbum: boolean) => {
    const key = `${folder.user}\n${folder.folder}`;
    setStarting(key);
    setError('');
    try {
      const job = asAlbum && release ? await downloadAlbum(release, 'any', folder) : await downloadSharedFolder(folder);
      useLibraryStore.getState().toast(`Downloading ${job.album} from ${folder.user}`, 'success');
      stop.current?.();
      onStarted?.();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(query);
  };

  return (
    <Dialog title={song ? `Find “${song.title}”` : 'Search Soulseek'} icon={<Search className="h-5 w-5" />} onClose={onClose} priority={120} size="xl" divided>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-[240px] flex-1 items-center gap-2 rounded border border-white/25 bg-black/40 px-3 py-2.5 transition-colors focus-within:border-white/60">
          <Search className="h-4 w-4 shrink-0 text-white/60" aria-hidden />
          <input
            ref={input}
            aria-label="Search Soulseek"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Artist, album or song"
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/40"
          />
        </label>
        <button type="submit" className="nf-btn-red px-5" disabled={!query.trim()}>
          Search
        </button>
      </form>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl value={filter} options={FILTERS} onChange={setFilter} ariaLabel="Format" size="sm" />
        <p className="flex items-center gap-2 text-xs text-white/55" role="status">
          {searching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {result?.blocked
            ? null
            : result
              ? song
                ? `${result.files.length} ${result.files.length === 1 ? 'file' : 'files'} from ${result.people} ${result.people === 1 ? 'person' : 'people'}${searching ? ' so far' : ''}`
                : `${result.folders.length} ${result.folders.length === 1 ? 'folder' : 'folders'} from ${result.people} ${result.people === 1 ? 'person' : 'people'}${searching ? ' so far' : ''}`
              : searching
                ? 'Asking everyone on Soulseek…'
                : ''}
        </p>
      </div>
      {song && (
        <p className="mt-3 text-xs leading-relaxed text-white/45">
          Files marked <span className="text-emerald-300">Matches</span> have the title, the artist and the length of <span className="text-white/70">{song.title}</span>. Whichever you pick is downloaded, tagged as this song and added to the playlist.
        </p>
      )}
      {release && (
        <p className="mt-3 text-xs leading-relaxed text-white/45">
          Folders with all {total} songs download as <span className="text-white/70">{release.title}</span>: checked against the tracklist, tagged and filed like any album. Other folders download as they are, into your music folder’s Soulseek folder.
        </p>
      )}
      {(error || result?.blocked) && (
        <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error || `Soulseek blocks searches for “${result?.blocked}”, so nothing can be found for it there.`}
        </p>
      )}
      {song && (
        <ul className="mt-4 space-y-1" aria-label="Shared files">
          {files.map((f) => {
            const key = `${f.user}\n${f.path}`;
            return (
              <li key={key} className="flex items-center gap-3 rounded-lg bg-white/[0.04] p-2.5 pl-3">
                <Music2 className="h-4 w-4 shrink-0 text-white/40" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={f.path}>
                    {folderName(f.path)}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-white/50">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${f.freeSlot ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden />
                    <span>{f.user}</span>
                    <span>{f.freeSlot ? 'ready to send' : 'has a queue'}</span>
                    {f.duration != null && <span>· {clock(f.duration)}</span>}
                    <span>· {megabytes(f.size)}</span>
                  </span>
                </span>
                <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-bold">{fileFormat(f)}</span>
                {f.matches && (
                  <span className="flex shrink-0 items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <Check className="h-3 w-3" strokeWidth={3} /> Matches
                  </span>
                )}
                <button type="button" className={`${f.matches ? 'nf-btn-red' : 'nf-btn-ghost'} h-9 shrink-0 px-3 text-xs`} disabled={starting != null} onClick={() => void pickFile(f)}>
                  {starting === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Download
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ul className="mt-4 space-y-1.5" aria-label="Shared folders">
        {folders.map((f) => {
          const key = `${f.user}\n${f.folder}`;
          const complete = release != null && f.matched === total;
          const expanded = open === key;
          return (
            <li key={key} className="rounded-lg bg-white/[0.04]">
              <div className="flex items-center gap-3 p-3">
                <button type="button" onClick={() => setOpen(expanded ? null : key)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={expanded}>
                  <Folder className="h-5 w-5 shrink-0 text-white/45" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold" title={f.folder}>
                      {folderName(f.folder)}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-white/50">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${f.freeSlot ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden />
                      <span>{f.user}</span>
                      <span>{f.freeSlot ? 'ready to send' : 'has a queue'}</span>
                      <span>· {f.files.length} {f.files.length === 1 ? 'file' : 'files'}</span>
                      <span>· {megabytes(f.size)}</span>
                    </span>
                  </span>
                  <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-bold">{formatLabel(f)}</span>
                  {release && (
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${complete ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-white/50'}`}>
                      {f.matched ?? 0} of {total} songs
                    </span>
                  )}
                  <ChevronDown className={`h-4 w-4 shrink-0 text-white/45 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
                <button
                  type="button"
                  className={`${complete ? 'nf-btn-red' : 'nf-btn-ghost'} h-9 shrink-0 px-3 text-xs`}
                  disabled={starting != null}
                  onClick={() => void download(f, complete)}
                  title={complete ? 'Download, check and tag it as this album' : 'Download these files as they are'}
                >
                  {starting === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {complete ? 'Download album' : release ? 'Download as is' : 'Download'}
                </button>
              </div>
              {expanded && (
                <ol className="border-t border-white/[0.06] px-4 py-2 text-xs text-white/60">
                  {f.files.map((file) => (
                    <li key={file.path} className="flex gap-3 py-1">
                      <span className="min-w-0 flex-1 truncate">{pathInFolder(f.folder, file.path)}</span>
                      <span className="tabular-nums text-white/40">{clock(file.duration)}</span>
                      <span className="w-14 text-right tabular-nums text-white/40">{megabytes(file.size)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
      {result?.done && !result.blocked && (song ? files.length === 0 : folders.length === 0) && (
        <p className="py-10 text-center text-sm text-white/50">
          {(song ? result.files.length : result.folders.length) ? `No ${song ? 'files' : 'folders'} in this format.` : 'Nobody is sharing anything that matches. Try fewer or different words.'}
        </p>
      )}
    </Dialog>
  );
}
