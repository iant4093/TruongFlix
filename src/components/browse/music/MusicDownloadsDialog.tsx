import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, ChevronDown, Copy, Download, FolderOpen, ListMusic, Loader2, Music2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { cancelAlbumJob, connectSoulseek, dismissAlbumJob, isActive, jobLabel, useMusicDownloads, type AlbumJob } from '../../../services/musicDownloads';
import { errorMessage } from '../../../lib/errors';
import { SOURCE_NAMES, importCounts, usePlaylistImports } from '../../../services/playlistImport';
import Dialog from '../../common/Dialog';
import { CoverArt } from './MusicArt';

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(0, bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`);

/** Soulseek's connection and every album download, newest first. */
export default function MusicDownloadsDialog({ onClose }: { onClose: () => void }) {
  const status = useMusicDownloads((s) => s.status);
  // A new array on every read would re-render forever: compare the jobs themselves.
  const jobs = useMusicDownloads(useShallow((s) => Object.values(s.jobs)));
  // A playlist's songs show as one row for the playlist.
  const ordered = jobs.filter((j) => !j.group).sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
  const importOrder = usePlaylistImports((s) => s.order);
  const imports = usePlaylistImports((s) => s.imports);
  const playlists = importOrder.map((id) => imports[id]).filter((p) => p && (p.running || p.songs.some((x) => x.state !== 'waiting')));
  const reconnect = () =>
    void connectSoulseek(true).catch((e) => useLibraryStore.getState().toast(errorMessage(e), 'error'));
  return (
    <Dialog title="Music downloads" icon={<Download className="h-5 w-5" />} onClose={onClose} priority={110} size="md" divided>
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg bg-white/5 p-3 text-sm">
        <SoulseekDot state={status.state} />
        <span className="flex-1">
          {status.state === 'online'
            ? `Connected to Soulseek as ${status.username}`
            : status.state === 'connecting'
              ? 'Connecting to Soulseek…'
              : status.state === 'error'
                ? status.message || 'Soulseek isn’t connected'
                : 'Not connected. Soulseek connects when you start a download.'}
        </span>
        {status.state !== 'online' && status.state !== 'connecting' && (
          <button className="nf-btn-ghost h-8 px-3 text-xs" onClick={reconnect}>
            Connect
          </button>
        )}
      </div>
      {playlists.length > 0 && (
        <ul className="mb-2 space-y-2" aria-label="Playlist imports">
          {playlists.map((p) => {
            const c = importCounts(p);
            const got = c.done + c.owned;
            return (
              <li key={p.id} className="flex items-center gap-4 rounded-lg p-2">
                <CoverArt url={p.cover} className="w-14 shrink-0" rounded="rounded" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                    <ListMusic className="h-3.5 w-3.5 shrink-0 text-white/50" /> {p.name}
                  </p>
                  <p className="truncate text-xs text-white/55">{SOURCE_NAMES[p.source]} playlist</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-white/65">
                    {p.running && <Loader2 className="h-3 w-3 animate-spin" />}
                    {got} of {c.total} songs in your library{c.failed ? ` · ${c.failed} not found` : ''}
                  </p>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/15">
                    <div className="h-full rounded-full bg-[#ff4560] transition-[width] duration-500" style={{ width: `${c.total ? (got / c.total) * 100 : 0}%` }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {ordered.length === 0 && playlists.length === 0 ? (
        <div className="py-12 text-center text-white/50">
          <Music2 className="mx-auto mb-3 h-9 w-9" />
          Albums you download from Browse appear here.
        </div>
      ) : (
        <ul className="space-y-2">
          {ordered.map((job) => (
            <JobRow key={job.id} job={job} cover={job.cover} />
          ))}
        </ul>
      )}
      <ActivityLog />
    </Dialog>
  );
}

/** What Soulseek has been doing: searches and how many people answered, transfers, connection drops. */
function ActivityLog() {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const read = () => void invoke<string[]>('slsk_activity').then((l) => alive && setLines(l ?? [])).catch(() => {});
    read();
    const timer = setInterval(read, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);
  const copy = () => {
    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <section className="mt-6 border-t border-white/10 pt-4">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-white/50 hover:text-white/80" aria-expanded={open}>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} /> Activity
        </button>
        {open && lines.length > 0 && (
          <button type="button" className="nf-btn-ghost ml-auto h-7 px-2.5 text-xs" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {open && (
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/60 [scrollbar-width:thin]">
          {lines.length ? lines.join('\n') : 'Nothing yet. Searches, transfers and connection changes show here.'}
        </pre>
      )}
    </section>
  );
}

export function SoulseekDot({ state }: { state: string }) {
  const colour = state === 'online' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-300 animate-pulse' : state === 'error' ? 'bg-nf-red' : 'bg-white/30';
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${colour}`} aria-hidden />;
}

function JobRow({ job, cover }: { job: AlbumJob; cover: string | null }) {
  const active = isActive(job);
  const progress = job.total > 0 ? Math.min(1, job.bytes / job.total) : 0;
  return (
    <li className="flex items-center gap-4 rounded-lg p-2 hover:bg-white/[0.04]">
      <CoverArt url={cover} className="w-14 shrink-0" rounded="rounded" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{job.album}</p>
        <p className="truncate text-xs text-white/55">{job.artist}</p>
        <p className={`mt-1 flex items-center gap-1.5 text-xs ${job.state === 'failed' ? 'text-red-300' : job.state === 'done' ? 'text-emerald-300' : 'text-white/65'}`}>
          {active && <Loader2 className="h-3 w-3 animate-spin" />}
          {jobLabel(job)}
          {job.source && active && <span className="text-white/40">· {job.source.format.toUpperCase()} from {job.source.user}</span>}
          {job.state === 'downloading' && <span className="text-white/40">· {size(job.bytes)} of {size(job.total)}</span>}
        </p>
        {job.state === 'failed' && job.message && <p className="mt-0.5 line-clamp-2 text-xs text-white/45">{job.message}</p>}
        {active && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/15">
            <div className="h-full rounded-full bg-[#ff4560] transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>
      {active ? (
        <button className="nf-btn-ghost h-8 px-3 text-xs" onClick={() => void cancelAlbumJob(job.id)} aria-label={`Cancel ${job.album}`}>
          <X className="h-3.5 w-3.5" /> Cancel
        </button>
      ) : (
        <div className="flex gap-2">
          {job.state === 'done' && (
            <button className="nf-btn-ghost h-8 px-3 text-xs" onClick={() => useLibraryStore.getState().setView('music')} title={job.path ?? undefined}>
              <FolderOpen className="h-3.5 w-3.5" /> Music
            </button>
          )}
          <button className="nf-btn-ghost h-8 w-8 justify-center p-0" onClick={() => void dismissAlbumJob(job.id)} aria-label={`Remove ${job.album} from the list`}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}
