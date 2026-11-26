import { useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronLeft, ListMusic, Loader2, Play, RotateCw, Search, Square, Trash2 } from 'lucide-react';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { openRoute, openTab } from '../../../music/nav';
import type { MusicQuality } from '../../../types/media';
import { errorMessage } from '../../../lib/errors';
import {
  SOURCE_NAMES,
  addImport,
  coreTitle,
  importCounts,
  readPlaylist,
  removeImport,
  retrySong,
  setImportQuality,
  songArtists,
  startImport,
  stopImport,
  usePlaylistImports,
  type ImportSong,
  type PlaylistImport,
} from '../../../services/playlistImport';
import { hasSoulseekAccount } from '../../../services/musicDownloads';
import Dropdown from '../../common/Dropdown';
import SegmentedControl from '../../common/SegmentedControl';
import { CoverArt } from './MusicArt';
import SoulseekSearchDialog from './SoulseekSearchDialog';

const QUALITIES: { value: MusicQuality; label: string }[] = [
  { value: 'lossless', label: 'Lossless (FLAC)' },
  { value: 'mp3', label: 'MP3 (256–320 kbps)' },
  { value: 'any', label: 'Best available' },
];

const clock = (ms: number | null) => {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Browse → Music → Import playlist: paste a playlist link (or a list of songs), see its songs, and
 * download them all; what couldn't be found stays listed, to be found by hand.
 */
export default function MusicPlaylistImport({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const current = usePlaylistImports((s) => (openId ? s.imports[openId] : undefined));
  if (current) return <ImportDetail playlist={current} onBack={() => onOpen(null)} />;
  return <ImportStart onOpen={onOpen} />;
}

function ImportStart({ onOpen }: { onOpen: (id: string) => void }) {
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const order = usePlaylistImports((s) => s.order);
  const imports = usePlaylistImports((s) => s.imports);
  const read = async () => {
    setReading(true);
    setError('');
    try {
      const playlist = await readPlaylist(text);
      onOpen(addImport(playlist, useLibraryStore.getState().settings.soulseek_quality));
      setText('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  };
  return (
    <div className="max-w-3xl">
      <h3 className="text-2xl font-bold tracking-tight">Import a playlist</h3>
      <p className="mt-1 text-sm text-white/55">Paste a playlist from a streaming service. Every song is matched to the store, then found and downloaded from Soulseek into your music folder, and the playlist is added to Music.</p>
      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          void read();
        }}
      >
        <textarea
          aria-label="Playlist link or songs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !text.includes('\n')) {
              e.preventDefault();
              void read();
            }
          }}
          rows={text.includes('\n') ? 8 : 2}
          placeholder={'https://open.spotify.com/playlist/…\n…or one song per line: Artist - Title'}
          className="w-full resize-y rounded border border-white/25 bg-black/40 px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-white/35 focus:border-white/60"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="submit" className="nf-btn-red px-6" disabled={!text.trim() || reading}>
            {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListMusic className="h-4 w-4" />}
            Read playlist
          </button>
          <span className="text-xs text-white/45">Spotify (first 100 songs) · Apple Music · YouTube and YouTube Music (first 100) · Tidal, Deezer and others: paste an exported CSV</span>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
      {order.length > 0 && (
        <section className="mt-10">
          <h4 className="mb-3 text-sm font-bold uppercase tracking-widest text-white/50">Imports</h4>
          <ul className="space-y-2">
            {order.map((id) => imports[id] && <ImportRow key={id} playlist={imports[id]} onOpen={() => onOpen(id)} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function ImportRow({ playlist, onOpen }: { playlist: PlaylistImport; onOpen: () => void }) {
  const c = importCounts(playlist);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-4 rounded-lg bg-white/[0.04] p-3 text-left hover:bg-white/[0.08]">
        <CoverArt url={playlist.cover} px={120} className="w-14 shrink-0" rounded="rounded" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{playlist.name}</span>
          <span className="block text-xs text-white/50">
            {SOURCE_NAMES[playlist.source]} · {c.done + c.owned} of {c.total} songs in your library{c.failed ? ` · ${c.failed} not found` : ''}
          </span>
        </span>
        {playlist.running && <Loader2 className="h-4 w-4 animate-spin text-white/60" />}
      </button>
    </li>
  );
}

type Filter = 'all' | 'missing' | 'got';

function ImportDetail({ playlist, onBack }: { playlist: PlaylistImport; onBack: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [finding, setFinding] = useState<ImportSong | null>(null);
  const settings = useLibraryStore((s) => s.settings);
  const c = importCounts(playlist);
  const left = c.total - c.done - c.owned;
  const ready = !!settings.music_directories.length && hasSoulseekAccount();
  const songs = useMemo(
    () =>
      playlist.songs.filter((s) =>
        filter === 'missing' ? s.state === 'failed' || s.state === 'cancelled' : filter === 'got' ? s.state === 'done' || s.state === 'owned' : true,
      ),
    [playlist.songs, filter],
  );
  const start = () => {
    setError('');
    void startImport(playlist.id).catch((e) => setError(errorMessage(e)));
  };
  const openInMusic = () => {
    if (playlist.playlistId == null) return;
    useLibraryStore.getState().setView('music');
    openTab('playlists');
    openRoute({ page: 'playlist', id: playlist.playlistId });
  };
  const progress = c.total ? (c.done + c.owned) / c.total : 0;
  const capped = playlist.source === 'spotify' && c.total >= 100 ? 'Spotify shares the first 100 songs of a playlist.' : playlist.total != null && playlist.total > c.total ? `The page listed ${c.total} of its ${playlist.total} songs.` : '';

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-5 inline-flex items-center gap-1 text-sm font-semibold text-white/60 hover:text-white">
        <ChevronLeft className="h-4 w-4" /> All imports
      </button>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <CoverArt url={playlist.cover} px={400} eager className="w-44 shrink-0 shadow-[0_18px_50px_rgba(0,0,0,0.6)]" rounded="rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">{SOURCE_NAMES[playlist.source]} playlist</p>
          <h3 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">{playlist.name}</h3>
          <p className="mt-1 text-sm text-white/55">
            {[playlist.owner, `${c.total} songs`, capped].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-3 text-sm text-white/75" role="status">
            {[c.done && `${c.done} downloaded`, c.owned && `${c.owned} already in your library`, c.failed && `${c.failed} not found`, left - c.failed > 0 && `${left - c.failed} to go`].filter(Boolean).join(' · ') || 'Nothing downloaded yet'}
          </p>
          <div className="mt-2 h-1.5 max-w-md overflow-hidden rounded-full bg-white/15" role="progressbar" aria-label="Songs in your library" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[#ff4560] transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {!ready ? (
              <button
                className="nf-btn-ghost"
                onClick={() => useLibraryStore.getState().setSettingsOpen(true, 'music')}
              >
                Set up downloads
              </button>
            ) : playlist.running ? (
              <button className="nf-btn-ghost" onClick={() => stopImport(playlist.id)}>
                <Square className="h-4 w-4" /> Stop
              </button>
            ) : (
              left > 0 && (
                <button className="nf-btn-red px-6" onClick={start}>
                  <ListMusic className="h-4 w-4" />
                  {c.done || c.failed ? `Download the other ${left}` : `Download ${left} ${left === 1 ? 'song' : 'songs'}`}
                </button>
              )
            )}
            {!playlist.running && <Dropdown value={playlist.quality} options={QUALITIES} onChange={(q) => setImportQuality(playlist.id, q)} ariaLabel="Download quality" />}
            {playlist.finishing && (
              <span className="flex items-center gap-2 text-sm text-white/60">
                <Loader2 className="h-4 w-4 animate-spin" /> Adding to your library…
              </span>
            )}
            {playlist.playlistId != null && !playlist.finishing && (
              <button className="nf-btn-ghost" onClick={openInMusic}>
                <Play className="h-4 w-4 fill-current" /> Open in Music
              </button>
            )}
            <button
              className="nf-btn-ghost px-3"
              aria-label="Remove this import"
              title="Remove this import (downloaded songs stay in your library)"
              onClick={() => {
                removeImport(playlist.id);
                onBack();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          {!ready && <p className="mt-3 text-sm text-white/55">Add a music folder and your Soulseek account in Settings → Music to download songs.</p>}
          {error && (
            <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </div>

      <div className="mb-3 mt-8 flex items-center justify-between gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          ariaLabel="Show songs"
          size="sm"
          options={[
            { value: 'all', label: `All ${c.total}` },
            { value: 'missing', label: `Not found ${c.failed}` },
            { value: 'got', label: `In your library ${c.done + c.owned}` },
          ]}
        />
      </div>
      <ol className="divide-y divide-white/[0.06]" aria-label="Songs">
        {songs.map((s) => (
          <SongRow key={s.key} song={s} number={Number(s.key) + 1} onFind={() => setFinding(s)} onRetry={() => retrySong(playlist.id, s.key)} />
        ))}
      </ol>
      {songs.length === 0 && <p className="py-10 text-center text-sm text-white/45">{filter === 'missing' ? 'Every song was found.' : 'No songs here yet.'}</p>}
      {finding && (
        <SoulseekSearchDialog
          release={null}
          song={{ importId: playlist.id, key: finding.key, title: finding.store?.title ?? finding.title, artists: songArtists(finding), album: finding.store?.album ?? finding.album, lengthMs: finding.store?.lengthMs ?? (finding.lengthTrusted ? finding.lengthMs : null) }}
          onClose={() => setFinding(null)}
        />
      )}
    </div>
  );
}

function SongRow({ song, number, onFind, onRetry }: { song: ImportSong; number: number; onFind: () => void; onRetry: () => void }) {
  const title = song.store?.title ?? song.title;
  const artist = song.store?.artist ?? song.artists.join(', ');
  const album = song.store?.album ?? song.album;
  const missing = song.state === 'failed' || song.state === 'cancelled';
  return (
    <li className="flex items-center gap-4 rounded-md px-2 py-2 hover:bg-white/[0.04]">
      <span className="w-6 text-right text-sm tabular-nums text-white/40">{number}</span>
      <CoverArt url={song.store?.cover ?? song.cover} px={100} className="w-10 shrink-0" rounded="rounded" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-xs text-white/50">
          {artist}
          {album ? ` · ${album}` : ''}
        </span>
        {missing && song.message && <span className="block truncate text-xs text-red-300/80" title={song.message}>{song.message}</span>}
      </span>
      <span className="hidden w-12 text-right text-sm tabular-nums text-white/45 sm:block">{clock(song.store?.lengthMs ?? song.lengthMs)}</span>
      <span className="flex w-56 shrink-0 items-center justify-end gap-2 text-xs">
        <SongStatus song={song} />
        {missing && (
          <>
            <button className="nf-btn-ghost h-8 px-3 text-xs" onClick={onFind} title="Search Soulseek for this song yourself">
              <Search className="h-3.5 w-3.5" /> Find it
            </button>
            <button className="nf-btn-ghost h-8 px-2 text-xs" onClick={onRetry} aria-label={`Try ${coreTitle(title)} again`} title="Try again">
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </span>
    </li>
  );
}

function SongStatus({ song }: { song: ImportSong }) {
  switch (song.state) {
    case 'waiting':
      return <span className="text-white/35">Waiting</span>;
    case 'matching':
    case 'searching':
      return (
        <span className="flex items-center gap-1.5 text-white/60">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching
        </span>
      );
    case 'queued':
      return <span className="text-white/60">In line</span>;
    case 'downloading':
      return (
        <span className="flex items-center gap-2 text-white/70">
          <span className="h-1 w-16 overflow-hidden rounded-full bg-white/15">
            <span className="block h-full bg-[#ff4560]" style={{ width: `${Math.round(song.progress * 100)}%` }} />
          </span>
          {Math.round(song.progress * 100)}%
        </span>
      );
    case 'checking':
      return <span className="text-white/60">Checking</span>;
    case 'done':
      return (
        <span className="flex items-center gap-1 text-emerald-300">
          <Check className="h-3.5 w-3.5" strokeWidth={3} /> Downloaded
        </span>
      );
    case 'owned':
      return <span className="text-emerald-300/80">In your library</span>;
    case 'cancelled':
      return <span className="text-white/45">Stopped</span>;
    default:
      return <span className="font-semibold text-red-300">Not found</span>;
  }
}
