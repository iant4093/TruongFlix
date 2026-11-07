import { useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle, CheckCircle2, FileCog, FolderOpen, Gamepad2, Loader2, Pause, Play, RotateCcw, Trash2, X,
} from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useLibraryStore } from '../../store/useLibraryStore';
import { formatBytes, formatEta, formatSpeed, pauseTorrent, resumeTorrent } from '../../services/torrents';
import { revealInFileManager } from '../../services/files';
import {
  cancelJob, deleteInstallerNow, launchGame, removeGame, retryDownload, setGameExe, uninstallGame, useGamesStore,
} from '../jobs';
import type { LibraryGame } from '../types';
import GameCover from './GameCover';
import InstallDialog from './InstallDialog';
import { formatPlayTime, gameProgress, gameStatusLabel } from './status';

const store = () => useLibraryStore.getState();
const report = (p: Promise<unknown>) => void p.catch((e) => store().toast(e instanceof Error ? e.message : String(e), 'error'));

type Filter = 'all' | 'installed' | 'active';
const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All games' }, { value: 'installed', label: 'Installed' }, { value: 'active', label: 'Downloads & installs' },
];

const isInstalled = (g: LibraryGame) => g.status === 'installed' || g.status === 'verify_failed';

function LibraryCard({ game, onOpen }: { game: LibraryGame; onOpen: () => void }) {
  const job = useGamesStore((s) => s.jobs[game.id]);
  const running = useGamesStore((s) => !!s.running[game.id]);
  const torrent = useLibraryStore((s) => (game.infoHash ? s.torrents.find((t) => t.infoHash === game.infoHash) : undefined));
  const progress = gameProgress(game, job, torrent);
  const installed = isInstalled(game) && !job;
  return <div className="group relative min-w-0">
    <button type="button" onClick={onOpen} aria-label={`${game.title} — ${running ? 'Playing' : gameStatusLabel(game, job, torrent)}`} className="w-full text-left">
      <div className="relative overflow-hidden rounded-md ring-white/70 transition duration-200 group-hover:-translate-y-1 group-hover:ring-2 group-focus-within:ring-2">
        <GameCover url={game.cover} title={game.title} className={`aspect-[3/4] w-full ${installed ? '' : 'opacity-60 grayscale-[40%]'}`} />
        {!installed && <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-transparent p-2.5 pt-8">
          <p className="truncate text-xs font-semibold">{gameStatusLabel(game, job, torrent)}</p>
          {progress != null && <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/20"><div className="h-full bg-nf-red transition-all" style={{ width: `${Math.max(2, progress)}%` }} /></div>}
        </div>}
        {(game.status === 'install_failed' || game.status === 'verify_failed') && !job && <AlertTriangle aria-hidden="true" className="absolute right-2 top-2 h-5 w-5 text-amber-400 drop-shadow" />}
        {running && <span className="absolute left-2 top-2 rounded bg-nf-green px-2 py-0.5 text-[10px] font-bold text-black">PLAYING</span>}
      </div>
      <h3 className="mt-2.5 line-clamp-2 text-sm font-semibold leading-snug">{game.title}</h3>
      <p className="mt-0.5 text-xs text-white/50">{installed ? formatPlayTime(game.playSeconds) : game.subtitle}</p>
    </button>
    {installed && !running && <button type="button" aria-label={`Play ${game.title}`} onClick={() => report(launchGame(game.id))}
      className="absolute left-1/2 top-[38%] flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-black opacity-0 shadow-lg transition group-hover:opacity-100 focus-visible:opacity-100">
      <Play className="ml-0.5 h-6 w-6 fill-current" />
    </button>}
  </div>;
}

function GameDialog({ game, onClose }: { game: LibraryGame; onClose: () => void }) {
  const job = useGamesStore((s) => s.jobs[game.id]);
  const running = useGamesStore((s) => !!s.running[game.id]);
  const failures = useGamesStore((s) => s.verifyFailures[game.id]);
  const torrent = useLibraryStore((s) => (game.infoHash ? s.torrents.find((t) => t.infoHash === game.infoHash) : undefined));
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, active: !installing, priority: 100 });
  const progress = gameProgress(game, job, torrent);
  const installed = isInstalled(game);
  const hasInstaller = !!game.installerDir && game.status !== 'downloading';

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); } catch (e) { store().toast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const confirmThen = async (title: string, message: string, confirmLabel: string, action: () => Promise<unknown>) => {
    if (await store().confirm({ title, message, confirmLabel, danger: true })) await run(action);
  };
  const chooseExe = () => run(async () => {
    const picked = await open({ title: 'Choose the game program', defaultPath: game.installDir ?? undefined, filters: [{ name: 'Programs', extensions: ['exe'] }] });
    if (typeof picked === 'string') await setGameExe(game.id, picked);
  });

  let primary: React.ReactNode = null;
  if (job) {
    primary = <button className="nf-btn-ghost" disabled={busy || !['starting', 'installing', 'finalizing'].includes(job.phase)} onClick={() => void run(() => cancelJob(game.id))}><X className="h-4 w-4" />Cancel install</button>;
  } else if (installed) {
    primary = <button className="nf-btn-play" disabled={running || busy || !game.exePath} onClick={() => void run(() => launchGame(game.id))}>
      <Play className="h-5 w-5 fill-current" />{running ? 'Playing' : 'Play'}
    </button>;
  } else if (game.status === 'downloading') {
    primary = torrent ? <button className="nf-btn-ghost" disabled={busy} onClick={() => void run(() => (torrent.paused ? resumeTorrent(torrent.infoHash) : pauseTorrent(torrent.infoHash)))}>
      {torrent.paused ? <><Play className="h-4 w-4" />Resume download</> : <><Pause className="h-4 w-4" />Pause download</>}
    </button> : <button className="nf-btn-red" disabled={busy} onClick={() => void run(() => retryDownload(game.id))}><RotateCcw className="h-4 w-4" />Download again</button>;
  } else if (hasInstaller) {
    primary = <button className="nf-btn-red" disabled={busy} onClick={() => setInstalling(true)}><Gamepad2 className="h-5 w-5" />{game.status === 'downloaded' ? 'Install' : 'Install again'}</button>;
  } else if (game.status === 'install_failed') {
    primary = <button className="nf-btn-red" disabled={busy || !game.detail} onClick={() => void run(() => retryDownload(game.id))}><RotateCcw className="h-4 w-4" />Download again</button>;
  }

  const facts: [string, string][] = [];
  if (installed) {
    facts.push(['Play time', formatPlayTime(game.playSeconds)]);
    if (game.lastPlayed) facts.push(['Last played', new Date(game.lastPlayed).toLocaleDateString()]);
    if (game.installedAt) facts.push(['Installed', new Date(game.installedAt).toLocaleDateString()]);
    if (game.sizeBytes) facts.push(['Size on disk', formatBytes(game.sizeBytes)]);
    if (game.installDir) facts.push(['Location', game.installDir]);
  }
  if (game.status === 'downloading' && torrent) {
    facts.push(['Downloaded', `${formatBytes(torrent.progressBytes)} of ${formatBytes(torrent.totalBytes)}`]);
    if (!torrent.paused) facts.push(['Speed', `${formatSpeed(torrent.downloadSpeedBps)} · ${torrent.peersLive} peers`], ['Time left', formatEta(torrent.etaSecs)]);
  }
  if (hasInstaller && game.installerDir) facts.push(['Installer', game.installerDir]);

  return <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/80 px-6 py-12" onMouseDown={onBackdropMouseDown}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={game.title} className="relative w-full max-w-4xl rounded-lg bg-[#181818] p-8 shadow-2xl outline-none">
      <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-full bg-white/10 p-2 hover:bg-white/20"><X className="h-5 w-5" /></button>
      <div className="flex flex-col gap-8 md:flex-row">
        <GameCover url={game.cover} title={game.title} className="aspect-[3/4] w-44 shrink-0 self-start rounded-md shadow-card md:w-56" />
        <div className="min-w-0 flex-1">
          <h2 className="pr-10 text-3xl font-bold leading-tight">{game.title}</h2>
          {game.subtitle && <p className="mt-1.5 text-sm text-white/55">{game.subtitle}</p>}
          <p className="mt-4 flex items-center gap-2 text-sm font-medium">
            {job || game.status === 'downloading' ? <Loader2 className="h-4 w-4 animate-spin text-white/70" />
              : installed && game.status === 'installed' ? <CheckCircle2 className="h-4 w-4 text-nf-green" />
                : game.status === 'install_failed' || game.status === 'verify_failed' ? <AlertTriangle className="h-4 w-4 text-amber-400" /> : null}
            {running ? 'Playing now' : gameStatusLabel(game, job, torrent)}
          </p>
          {progress != null && <div className="mt-3 h-1.5 max-w-md overflow-hidden rounded bg-white/15"><div className="h-full bg-nf-red transition-all" style={{ width: `${Math.max(2, progress)}%` }} /></div>}
          {job?.status && <p className="mt-2 truncate text-xs text-white/50">{job.status}</p>}
          {game.error && !job && <p role="alert" className="mt-4 rounded border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">{game.error}</p>}
          {failures && failures.length > 0 && <details className="mt-3 text-sm text-white/70">
            <summary className="cursor-pointer">Files that didn't verify ({failures.length})</summary>
            <ul className="selectable mt-2 max-h-40 overflow-y-auto rounded bg-black/30 p-3 font-mono text-xs">{failures.map((f) => <li key={f}>{f}</li>)}</ul>
          </details>}
          {installed && !game.exePath && !job && <p className="mt-4 text-sm text-white/70">TruongFlix couldn't tell which program starts this game. <button className="underline" onClick={() => void chooseExe()}>Choose it</button>.</p>}
          <div className="mt-6 flex flex-wrap gap-3">{primary}</div>
          {facts.length > 0 && <dl className="mt-7 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            {facts.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-white/45">{label}</dt><dd className="selectable mt-0.5 break-all text-white/85">{value}</dd></div>)}
          </dl>}
          {!job && <div className="mt-8 flex flex-wrap gap-2 border-t border-white/10 pt-5">
            {installed && game.installDir && <button className="nf-btn-ghost text-sm" onClick={() => report(revealInFileManager(game.installDir!))}><FolderOpen className="h-4 w-4" />Open folder</button>}
            {installed && <button className="nf-btn-ghost text-sm" disabled={busy} onClick={() => void chooseExe()}><FileCog className="h-4 w-4" />Change program</button>}
            {installed && hasInstaller && <button className="nf-btn-ghost text-sm" disabled={busy} onClick={() => setInstalling(true)}><RotateCcw className="h-4 w-4" />Reinstall</button>}
            {hasInstaller && <button className="nf-btn-ghost text-sm" disabled={busy} onClick={() => void confirmThen('Delete installer?', `The downloaded installer for “${game.title}” will be deleted and stop seeding.${installed ? ' The installed game is not affected.' : ''}`, 'Delete installer', () => deleteInstallerNow(game.id))}><Trash2 className="h-4 w-4" />Delete installer</button>}
            {installed && <button className="nf-btn-ghost text-sm text-red-300" disabled={busy || running} onClick={() => void confirmThen('Uninstall game?', `“${game.title}” will be uninstalled and its folder deleted, including saved games stored there.`, 'Uninstall', async () => { await uninstallGame(game.id); })}><Trash2 className="h-4 w-4" />Uninstall</button>}
            {!installed && <button className="nf-btn-ghost text-sm text-red-300" disabled={busy} onClick={() => void confirmThen('Remove from library?', game.status === 'downloading' ? `The download of “${game.title}” will be cancelled and its files deleted.` : `“${game.title}” will be removed from your library${hasInstaller ? ' and its installer deleted' : ''}.`, 'Remove', async () => { await removeGame(game.id, true); onClose(); })}><Trash2 className="h-4 w-4" />Remove</button>}
            {installed && <button className="nf-btn-ghost text-sm" disabled={busy || running} onClick={() => void confirmThen('Remove from library?', `“${game.title}” stays installed on disk but is removed from TruongFlix.`, 'Remove', async () => { await removeGame(game.id, false); onClose(); })}>Remove from library</button>}
          </div>}
        </div>
      </div>
    </div>
    {installing && <InstallDialog game={game} onClose={() => setInstalling(false)} />}
  </div>;
}

export default function GameLibrary({ onBrowse }: { onBrowse: () => void }) {
  const games = useGamesStore((s) => s.games);
  const jobs = useGamesStore((s) => s.jobs);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const visible = games.filter((g) => filter === 'all' || (filter === 'installed' ? isInstalled(g) : !isInstalled(g) || !!jobs[g.id]));
  const open = games.find((g) => g.id === openId) ?? null;

  if (!games.length) return <div className="px-[4%] pt-10 text-center">
    <Gamepad2 className="mx-auto mb-5 h-12 w-12 text-white/40" />
    <h2 className="text-2xl font-bold">Your game library is empty</h2>
    <p className="mx-auto mt-3 max-w-md text-sm text-white/60">Games you download and install appear here.</p>
    <button className="nf-btn-red mx-auto mt-6" onClick={onBrowse}>Browse games</button>
  </div>;

  return <div className="px-[4%] pb-16">
    <div className="mb-7 flex rounded border border-white/20 bg-black/30 p-1 sm:w-fit" role="group" aria-label="Library filter">
      {filters.map((f) => <button key={f.value} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}
        className={`rounded px-4 py-1.5 text-sm font-medium ${filter === f.value ? 'bg-white text-black' : 'text-white/65 hover:text-white'}`}>{f.label}</button>)}
    </div>
    {visible.length === 0
      ? <p className="py-16 text-center text-white/50">Nothing here yet.</p>
      : <div className="grid grid-cols-3 gap-x-4 gap-y-8 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {visible.map((g) => <LibraryCard key={g.id} game={g} onOpen={() => setOpenId(g.id)} />)}
      </div>}
    {open && <GameDialog key={open.id} game={open} onClose={() => setOpenId(null)} />}
  </div>;
}
