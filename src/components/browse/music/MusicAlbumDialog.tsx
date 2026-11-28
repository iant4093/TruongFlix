import { useMemo, useState } from 'react';
import { AlertCircle, Download, Loader2, Music2, Play, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { albumDetail, albumKey, type CatalogAlbum, type CatalogArtist, type CatalogRelease } from '../../../services/musicCatalog';
import { cancelAlbumJob, downloadAlbum, isActive, jobLabel, useMusicDownloads } from '../../../services/musicDownloads';
import { openRoute, openTab } from '../../../music/nav';
import { useMusicPlayer } from '../../../music/player';
import useCatalogQuery from '../../../hooks/useCatalogQuery';
import type { MusicQuality } from '../../../types/media';
import { errorMessage } from '../../../lib/errors';
import Dialog from '../../common/Dialog';
import Dropdown from '../../common/Dropdown';
import { Bone } from '../../common/Skeleton';
import { CoverArt } from './MusicArt';
import SoulseekSearchDialog from './SoulseekSearchDialog';

const QUALITIES: { value: MusicQuality; label: string }[] = [
  { value: 'lossless', label: 'Lossless (FLAC)' },
  { value: 'mp3', label: 'MP3 (256–320 kbps)' },
  { value: 'any', label: 'Best available' },
];

const minutes = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
};
const clock = (ms: number | null) => {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** An album's page: cover, details, its tracklist, and downloading it (or playing it once it's yours). */
export default function MusicAlbumDialog({ album, onClose, onArtist, active = true }: { album: CatalogAlbum; onClose: () => void; onArtist: (artist: CatalogArtist) => void; active?: boolean }) {
  const detail = useCatalogQuery(`album:${album.id}`, () => albumDetail(album.id));
  const release = detail.data;
  const cover = release?.cover ?? album.cover;
  const artistId = release?.artistId ?? album.artistId;
  const [picking, setPicking] = useState(false);
  return (
    <>
      {/* `overflow-hidden` keeps the blurred cover inside the panel's rounded corners. */}
      <Dialog label={album.title} onClose={onClose} open={active} active={!picking} priority={100} size="xl" align="top" chrome="floating" className="overflow-hidden">
        <div className="relative">
          {/* The cover, blurred, behind the header. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-60 nf-fade-mask">
            <CoverArt url={cover} px={100} className="h-full w-full scale-125 blur-3xl" rounded="" eager />
          </div>
          <div className="relative flex flex-col gap-7 p-6 pt-10 sm:flex-row sm:items-end sm:p-9 sm:pt-12">
            <CoverArt url={cover} px={600} alt="" eager className="w-52 shrink-0 shadow-[0_18px_50px_rgba(0,0,0,0.6)] sm:w-60" rounded="rounded-lg" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">
                {[release?.type ?? album.type ?? 'Album', release?.year ?? album.year].filter(Boolean).join(' · ')}
                {(release?.explicit ?? album.explicit) && <span className="ml-2 rounded-sm bg-white/25 px-1 text-[10px] text-white">E</span>}
              </p>
              <h2 className="mt-2 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">{release?.title ?? album.title}</h2>
              <button
                type="button"
                className="mt-1 text-lg font-semibold text-[#ff4560] hover:underline disabled:no-underline"
                disabled={!artistId}
                onClick={() => artistId && onArtist({ id: artistId, name: release?.artist ?? album.artist })}
              >
                {release?.artist ?? album.artist}
              </button>
              {release && (
                <p className="mt-2 text-sm text-white/55">
                  {[`${release.tracks.length} ${release.tracks.length === 1 ? 'song' : 'songs'}`, minutes(release.tracks.reduce((n, t) => n + (t.lengthMs ?? 0), 0)), release.genres[0], release.label].filter(Boolean).join(' · ')}
                </p>
              )}
              {release ? <AlbumActions release={release} onClose={onClose} onPick={() => setPicking(true)} /> : !detail.error && <Bone className="mt-6 h-11 w-64 rounded" tone="soft" />}
            </div>
          </div>
        </div>
        <div className="px-6 pb-9 sm:px-9">
          {detail.error ? (
            <div role="alert" className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/70">
              <AlertCircle className="h-5 w-5 shrink-0 text-nf-red" />
              <span className="flex-1">Couldn’t load this album: {detail.error}</span>
              <button className="nf-btn-ghost" onClick={detail.retry}>
                <RefreshCw className="h-4 w-4" /> Retry
              </button>
            </div>
          ) : !release ? (
            <div role="status" aria-label="Loading tracklist" className="space-y-2">
              {Array.from({ length: 8 }, (_, i) => (
                <Bone key={i} className="h-10 w-full rounded" tone="soft" />
              ))}
            </div>
          ) : (
            <Tracklist release={release} />
          )}
        </div>
      </Dialog>
      {picking && release && active && <SoulseekSearchDialog release={release} onClose={() => setPicking(false)} />}
    </>
  );
}

function Tracklist({ release }: { release: CatalogRelease }) {
  const discs = useMemo(() => [...new Set(release.tracks.map((t) => t.disc))], [release.tracks]);
  return (
    <ol className="divide-y divide-white/[0.06]" aria-label="Tracklist">
      {discs.map((disc) => (
        <li key={disc}>
          {discs.length > 1 && <p className="pb-1 pt-4 text-xs font-bold uppercase tracking-widest text-white/45">Disc {disc}</p>}
          <ol>
            {release.tracks
              .filter((t) => t.disc === disc)
              .map((t) => (
                <li key={`${t.disc}-${t.position}`} className="flex items-center gap-4 rounded-md px-2 py-2.5 hover:bg-white/[0.05]">
                  <span className="w-6 text-right text-sm tabular-nums text-white/45">{t.position}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{t.title}</span>
                    {t.artist && t.artist !== release.artist && <span className="block truncate text-xs text-white/50">{t.artist}</span>}
                  </span>
                  <span className="text-sm tabular-nums text-white/45">{clock(t.lengthMs)}</span>
                </li>
              ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

function AlbumActions({ release, onClose, onPick }: { release: CatalogRelease; onClose: () => void; onPick: () => void }) {
  const settings = useLibraryStore((s) => s.settings);
  const library = useMusicPlayer((s) => s.library);
  // The latest download of this album (an object from the store, so it's stable between reads).
  const job = useMusicDownloads((s) => {
    let found;
    // A playlist song's download isn't this album's (a single's song shares its name).
    for (const j of Object.values(s.jobs)) if (j.kind !== 'song' && (j.releaseId === release.id || (j.album === release.title && j.artist === release.artist))) found = j;
    return found;
  });
  const [quality, setQuality] = useState<MusicQuality>(settings.soulseek_quality);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const owned = useMemo(() => library?.albums.find((a) => albumKey(a.title, a.artist) === albumKey(release.title, release.artist)) ?? null, [library, release]);

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      await downloadAlbum(release, quality);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };
  const openInMusic = () => {
    if (!owned) return;
    onClose();
    useLibraryStore.getState().setView('music');
    openTab('albums');
    openRoute({ page: 'album', id: owned.id });
  };

  if (owned)
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button className="nf-btn-red px-6" onClick={openInMusic}>
          <Play className="h-4 w-4 fill-current" /> Play in Music
        </button>
        <span className="text-sm text-white/55">This album is in your library.</span>
      </div>
    );
  if (!settings.music_directories.length)
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          className="nf-btn-ghost"
          onClick={() => {
            // Settings opens under Browse's dialogs, so this one steps aside.
            onClose();
            useLibraryStore.getState().setSettingsOpen(true, 'music');
          }}
        >
          <Settings2 className="h-4 w-4" /> Set up downloads
        </button>
        <span className="text-sm text-white/55">
          Add a music folder in Settings → Music to download albums.
        </span>
      </div>
    );
  if (job && isActive(job)) {
    const progress = job.total > 0 ? Math.min(1, job.bytes / job.total) : 0;
    return (
      <div className="mt-6 max-w-md">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-white/70" />
          <span className="flex-1 font-semibold">{jobLabel(job)}</span>
          {job.source && <span className="text-xs uppercase text-white/50">{job.source.format}</span>}
          <button className="nf-btn-ghost h-8 px-3 text-xs" onClick={() => void cancelAlbumJob(job.id)}>
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-[#ff4560] transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
        </div>
        {job.message && <p className="mt-2 text-xs text-white/50">{job.message}</p>}
      </div>
    );
  }
  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <button className="nf-btn-red px-6" onClick={() => void start()} disabled={starting}>
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {job?.state === 'failed' ? 'Try again' : 'Download'}
        </button>
        <Dropdown value={quality} options={QUALITIES} onChange={setQuality} ariaLabel="Download quality" />
        <button className="nf-btn-ghost" onClick={onPick} title="Search Soulseek and pick a copy yourself">
          <Search className="h-4 w-4" /> Choose a copy
        </button>
      </div>
      {(error || job?.state === 'failed') && (
        <p role="alert" className="mt-3 flex max-w-xl items-start gap-2 text-sm text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error || job?.message}
        </p>
      )}
      {job?.state === 'done' && !owned && (
        <p className="mt-3 flex items-center gap-2 text-sm text-white/60">
          <Music2 className="h-4 w-4" /> Downloaded. It appears in Music once the library scan finishes.
        </p>
      )}
      {!error && job?.state !== 'failed' && (
        <p className="mt-3 max-w-xl text-xs leading-relaxed text-white/45">
          Finds a complete copy of this album on Soulseek, downloads only its audio files, checks every track against this tracklist, then tags it and adds it to your music folder. Or choose a copy yourself.
        </p>
      )}
    </div>
  );
}
