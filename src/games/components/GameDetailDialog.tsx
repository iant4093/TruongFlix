import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, FileCog, FolderOpen, Loader2, Pause, Play, RotateCcw, Trash2, X,
} from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useLibraryStore } from '../../store/useLibraryStore';
import { formatBytes, formatEta, formatSpeed, pauseTorrent, resumeTorrent } from '../../services/torrents';
import { revealInFileManager } from '../../services/files';
import { BTN, BTN_DANGER } from '../../components/settings/ui';
import { deleteInstallerNow, removeGame, setGameExe, uninstallGame, useGamesStore } from '../jobs';
import { fetchGame } from '../source';
import type { GameCard, GameDetail, LibraryGame } from '../types';
import { hasInstaller, PrimaryAction, toastError, useBusy, useOwnedGame } from './actions';
import { MetaLine } from './GameBillboard';
import { useCachedImage } from './GameCover';
import DownloadDialog from './DownloadDialog';
import InstallDialog from './InstallDialog';
import { formatPlayTime, gameProgress, gameStatusLabel, isInstalled } from './status';

type Shot = { thumb: string; full: string };
const confirm = (title: string, message: string, confirmLabel: string) =>
  useLibraryStore.getState().confirm({ title, message, confirmLabel, danger: true });
const longDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function Screenshot({ shot, index, onOpen }: { shot: Shot; index: number; onOpen: () => void }) {
  const src = useCachedImage(shot.thumb);
  return (
    <button type="button" onClick={onOpen} aria-label={`Enlarge screenshot ${index + 1}`}
      className="group relative aspect-video overflow-hidden rounded-md bg-[#2f2f2f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
      {src && <img src={src} alt="" draggable={false} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />}
      <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20" />
    </button>
  );
}

function Lightbox({ shots, index, onIndex, onClose }: { shots: Shot[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const shot = shots[index];
  const src = useCachedImage(shot.full, shot.thumb);
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, priority: 120 });
  const step = (n: number) => onIndex((index + n + shots.length) % shots.length);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/90 p-8 backdrop-blur-xs" onMouseDown={onBackdropMouseDown}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Screenshot ${index + 1} of ${shots.length}`} className="relative outline-none"
        onKeyDown={(e) => { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); }}>
        {src ? <img src={src} alt="" className="max-h-[85vh] max-w-[90vw] rounded-md shadow-2xl" /> : <Loader2 className="h-8 w-8 animate-spin text-white/60" />}
        <button onClick={onClose} aria-label="Close screenshot" className="absolute -right-3 -top-3 flex h-9 w-9 items-center justify-center rounded-full bg-nf-surface hover:bg-[#2a2a2a]"><X className="h-5 w-5" /></button>
        {shots.length > 1 && <>
          <button aria-label="Previous screenshot" onClick={() => step(-1)} className="nf-circle-btn fixed left-6 top-1/2 h-11 w-11 -translate-y-1/2"><ChevronLeft className="h-5 w-5" /></button>
          <button aria-label="Next screenshot" onClick={() => step(1)} className="nf-circle-btn fixed right-6 top-1/2 h-11 w-11 -translate-y-1/2"><ChevronRight className="h-5 w-5" /></button>
          <span className="fixed bottom-6 left-1/2 -translate-x-1/2 text-sm tabular-nums text-white/70">{index + 1} / {shots.length}</span>
        </>}
      </div>
    </motion.div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <p><span className="text-nf-muted">{label}: </span>{children}</p>;
}

/** Live download, install and problem banners, styled like the movie details download banner. */
function StatusPanels({ game }: { game: LibraryGame }) {
  const { job, torrent } = useOwnedGame(game.slug);
  const failures = useGamesStore((s) => s.verifyFailures[game.id]);
  const { busy, run } = useBusy();
  const progress = gameProgress(game, job, torrent);
  const downloading = game.status === 'downloading' && !job;
  const chooseExe = () => run(async () => {
    const picked = await open({ title: 'Choose the game program', defaultPath: game.installDir ?? undefined, filters: [{ name: 'Programs', extensions: ['exe'] }] });
    if (typeof picked === 'string') await setGameExe(game.id, picked);
  });
  const panels: ReactNode[] = [];

  if (downloading && torrent) {
    panels.push(
      <div key="download" className="space-y-2.5 rounded-lg border border-sky-400/25 bg-sky-500/[0.07] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs tabular-nums">
          <span className="inline-flex items-center gap-1.5 font-semibold text-sky-300"><Download className="h-3.5 w-3.5" />{gameStatusLabel(game, job, torrent)}</span>
          <span className="text-white/80">{formatBytes(torrent.progressBytes)} of {formatBytes(torrent.totalBytes)}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-sky-400 transition-all duration-300" style={{ width: `${Math.max(2, torrent.progressPct)}%` }} />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs tabular-nums">
          <span className="text-nf-secondary">
            {torrent.paused ? 'Paused' : <><span className="text-sky-200">↓ {formatSpeed(torrent.downloadSpeedBps)}</span> · {torrent.peersLive} peers · {formatEta(torrent.etaSecs)} left</>}
          </span>
          <button className="nf-btn-ghost h-7 px-2.5 py-0 text-xs" disabled={busy}
            onClick={() => void run(() => (torrent.paused ? resumeTorrent(torrent.infoHash) : pauseTorrent(torrent.infoHash)))}>
            {torrent.paused ? <><Play className="h-3 w-3" />Resume</> : <><Pause className="h-3 w-3" />Pause</>}
          </button>
        </div>
      </div>,
    );
  }
  if (job) {
    panels.push(
      <div key="job" role="status" className="space-y-2.5 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
        <div className="flex items-center justify-between gap-4 text-xs tabular-nums">
          <span className="inline-flex items-center gap-1.5 font-semibold"><Loader2 className="h-3.5 w-3.5 animate-spin text-nf-red" />{gameStatusLabel(game, job, torrent)}</span>
          {job.status && <span className="min-w-0 truncate text-nf-secondary">{job.status}</span>}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          {progress != null
            ? <div className="h-full bg-nf-red transition-all duration-300" style={{ width: `${Math.max(2, progress)}%` }} />
            : <div className="h-full w-1/3 animate-pulse bg-nf-red/70" />}
        </div>
      </div>,
    );
  }
  if ((game.error || (failures && failures.length > 0)) && !job) {
    panels.push(
      <div key="error" role="alert" className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        {game.error && <p className="flex items-start gap-2.5"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><span className="selectable">{game.error}</span></p>}
        {failures && failures.length > 0 && (
          <details className="text-amber-100/80">
            <summary className="cursor-pointer select-none text-xs font-semibold">Files that didn't verify ({failures.length})</summary>
            <ul className="selectable mt-2 max-h-40 overflow-y-auto rounded bg-black/30 p-3 font-mono text-xs">{failures.map((f) => <li key={f}>{f}</li>)}</ul>
          </details>
        )}
      </div>,
    );
  }
  if (isInstalled(game) && !game.exePath && !job) {
    panels.push(
      <div key="exe" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-nf-secondary">
        <span>TruongFlix couldn't tell which program starts this game.</span>
        <button className="nf-btn-ghost h-8 px-3 py-0 text-xs" disabled={busy} onClick={() => void chooseExe()}><FileCog className="h-3.5 w-3.5" />Choose program</button>
      </div>,
    );
  }
  return panels.length ? <div className="space-y-2.5 px-12 pb-2 pt-3">{panels}</div> : null;
}

/** Management actions for a game in the library, with the same confirmations as before. */
function Manage({ game, onRemoved, onReinstall }: { game: LibraryGame; onRemoved: () => void; onReinstall: () => void }) {
  const running = useGamesStore((s) => !!s.running[game.id]);
  const { busy, run } = useBusy();
  const installed = isInstalled(game);
  const installer = hasInstaller(game);
  const confirmThen = async (title: string, message: string, label: string, action: () => Promise<unknown>) => {
    if (await confirm(title, message, label)) await run(action);
  };
  const chooseExe = () => run(async () => {
    const picked = await open({ title: 'Choose the game program', defaultPath: game.installDir ?? undefined, filters: [{ name: 'Programs', extensions: ['exe'] }] });
    if (typeof picked === 'string') await setGameExe(game.id, picked);
  });
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {installed && game.installDir && <button className={BTN} onClick={() => void revealInFileManager(game.installDir!).catch(toastError)}><FolderOpen className="h-4 w-4" />Open folder</button>}
      {installed && <button className={BTN} disabled={busy} onClick={() => void chooseExe()}><FileCog className="h-4 w-4" />Change program</button>}
      {installed && installer && <button className={BTN} disabled={busy} onClick={onReinstall}><RotateCcw className="h-4 w-4" />Reinstall</button>}
      {installer && <button className={BTN} disabled={busy} onClick={() => void confirmThen('Delete installer?', `The downloaded installer for “${game.title}” will be deleted and stop seeding.${installed ? ' The installed game is not affected.' : ''}`, 'Delete installer', () => deleteInstallerNow(game.id))}><Trash2 className="h-4 w-4" />Delete installer</button>}
      {installed && <button className={BTN_DANGER} disabled={busy || running} onClick={() => void confirmThen('Uninstall game?', `“${game.title}” will be uninstalled and its folder deleted, including saved games stored there.`, 'Uninstall', async () => { await uninstallGame(game.id); })}><Trash2 className="h-4 w-4" />Uninstall</button>}
      {!installed && <button className={BTN_DANGER} disabled={busy} onClick={() => void confirmThen('Remove from library?', game.status === 'downloading' ? `The download of “${game.title}” will be cancelled and its files deleted.` : `“${game.title}” will be removed from your library${installer ? ' and its installer deleted' : ''}.`, 'Remove', async () => { await removeGame(game.id, true); onRemoved(); })}><Trash2 className="h-4 w-4" />Remove</button>}
      {installed && <button className={BTN_DANGER} disabled={busy || running} onClick={() => void confirmThen('Remove from library?', `“${game.title}” stays installed on disk but is removed from TruongFlix.`, 'Remove', async () => { await removeGame(game.id, false); onRemoved(); })}>Remove from library</button>}
    </div>
  );
}

/** A game's details page, built like the movie and TV details modal. */
export default function GameDetailDialog({ origin, game, onClose, onOpenLibrary }: {
  origin: string;
  game: GameCard | GameDetail;
  onClose: () => void;
  onOpenLibrary: () => void;
}) {
  const { owned, job, running, torrent } = useOwnedGame(game.slug);
  const [fetched, setFetched] = useState<GameDetail | null>('magnet' in game ? game : null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [installing, setInstalling] = useState<LibraryGame | null>(null);
  const [shot, setShot] = useState<number | null>(null);
  const [showAllFeatures, setShowAllFeatures] = useState(false);
  const [fullDescription, setFullDescription] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, active: !downloading && !installing && shot == null, priority: 60 });
  const detail = fetched ?? owned?.detail ?? null;

  useEffect(() => {
    if (detail || !origin) return;
    let active = true;
    fetchGame(origin, game.slug)
      .then((d) => { if (active) d ? setFetched(d) : setError('This game is no longer on the source.'); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [origin, game.slug, detail]);

  const info = detail ?? game;
  const shots = detail?.screenshots ?? [];
  const backdrop = useCachedImage(shots[0]?.full ?? null, shots[0]?.thumb);
  const cover = useCachedImage(shots.length ? null : info.cover);
  const features = detail?.features ?? [];
  const installed = !!owned && isInstalled(owned);
  const description = detail?.description ?? '';
  const longText = description.length > 420;
  const loading = !detail && !error && !!origin;

  const status = owned && (
    running ? <span className="inline-flex items-center gap-1.5 font-semibold text-nf-green"><Play className="h-4 w-4 fill-current" strokeWidth={0} />Playing now</span>
      : owned.status === 'installed' && !job ? <span className="inline-flex items-center gap-1.5 font-semibold text-nf-green"><CheckCircle2 className="h-4 w-4" />Installed</span>
        : (owned.status === 'install_failed' || owned.status === 'verify_failed') && !job ? <span className="inline-flex items-center gap-1.5 font-semibold text-amber-300"><AlertTriangle className="h-4 w-4" />{gameStatusLabel(owned, job, torrent)}</span>
          : <span className={`font-semibold ${job ? 'text-white' : 'text-sky-300'}`}>{gameStatusLabel(owned, job, torrent)}</span>
  );

  const about: [string, ReactNode][] = [];
  if (detail?.companies.length) about.push(['Company', detail.companies.join(', ')]);
  if (detail?.genres.length) about.push(['Genres', detail.genres.join(', ')]);
  if (detail?.languages) about.push(['Languages', detail.languages]);
  if (detail?.originalSize) about.push(['Original size', detail.originalSize]);
  if (detail?.repackSize) about.push(['Download size', detail.repackSize + (detail.selective ? ' · some files optional' : '')]);
  if (owned && installed) {
    if (owned.sizeBytes) about.push(['Size on disk', formatBytes(owned.sizeBytes)]);
    if (owned.installedAt) about.push(['Installed', longDate(owned.installedAt)]);
    if (owned.installDir) about.push(['Location', <span className="selectable break-all">{owned.installDir}</span>]);
  }
  if (owned && hasInstaller(owned) && owned.installerDir) about.push(['Installer', <span className="selectable break-all">{owned.installerDir}</span>]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onMouseDown={onBackdropMouseDown}
      className="fixed inset-0 z-[60] flex justify-center overflow-y-auto bg-black/70 px-4 pb-10 pt-8 backdrop-blur-xs"
    >
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={info.title}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.94, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 30 }}
        transition={{ duration: 0.28, ease: [0.21, 0, 0.27, 1] }}
        className="relative h-max w-full max-w-4xl overflow-hidden rounded-xl bg-nf-surface shadow-2xl outline-none"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-[#232323]">
          {backdrop && <motion.img key={backdrop} src={backdrop} alt="" draggable={false} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}
            className={`h-full w-full object-cover ${owned?.status === 'downloading' || job ? 'opacity-65 grayscale-[50%]' : ''}`} />}
          {cover && <img src={cover} alt="" draggable={false} className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" />}
          <div className="absolute inset-0 bg-gradient-to-t from-nf-surface via-nf-surface/10 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-transparent to-transparent" />

          <button onClick={onClose} aria-label="Close"
            className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-nf-surface text-white hover:bg-[#2a2a2a]">
            <X className="h-5 w-5" />
          </button>

          <div className="absolute bottom-[8%] left-12 right-12 flex flex-col gap-5">
            <div>
              <h2 className={`text-shadow line-clamp-2 max-w-[80%] font-black uppercase leading-none tracking-tight ${info.title.length > 26 ? 'text-4xl' : 'text-5xl'}`}>{info.title}</h2>
              {info.subtitle && <p className="text-shadow mt-3 text-[15px] font-medium text-[#e5e5e5]">{info.subtitle}</p>}
            </div>
            <div className="flex items-center gap-2.5">
              <PrimaryAction slug={game.slug} detail={detail} onDownload={() => setDownloading(true)} onInstall={setInstalling} />
              {owned && installed && owned.installDir && (
                <button onClick={() => void revealInFileManager(owned.installDir!).catch(toastError)} title="Open install folder" aria-label="Open install folder" className="nf-circle-btn h-11 w-11">
                  <FolderOpen className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        {owned && <StatusPanels game={owned} />}

        <div className="grid grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)] gap-8 px-12 pb-8 pt-2">
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[15px]">
              {status}
              <MetaLine detail={detail} genres={false} />
              {detail?.selective && <span className="rounded-[3px] border border-white/40 px-1.5 py-px text-xs text-nf-secondary">Selective download</span>}
            </div>
            {owned && installed && (
              <p className="text-sm text-nf-secondary">
                {formatPlayTime(owned.playSeconds)}{owned.lastPlayed ? ` · Last played ${longDate(owned.lastPlayed)}` : ''}
              </p>
            )}
            {loading && <p role="status" className="flex items-center gap-2 text-sm text-nf-secondary"><Loader2 className="h-4 w-4 animate-spin" />Loading details…</p>}
            {error && !owned && <p role="alert" className="text-sm text-red-300">{error}</p>}
            {description
              ? <div>
                <p className={`selectable whitespace-pre-line text-[15px] leading-relaxed text-white ${longText && !fullDescription ? 'line-clamp-6' : ''}`}>{description}</p>
                {longText && <button className="mt-2 text-sm font-semibold text-nf-secondary hover:text-white" onClick={() => setFullDescription((v) => !v)}>{fullDescription ? 'Show less' : 'Read more'}</button>}
              </div>
              : detail && <p className="text-[15px] text-nf-secondary">No description available.</p>}
          </div>

          <div className="space-y-3 text-sm leading-relaxed">
            {detail?.genres.length ? <Fact label="Genres">{detail.genres.join(', ')}</Fact> : null}
            {detail?.companies.length ? <Fact label="Company">{detail.companies.join(', ')}</Fact> : null}
            {detail?.languages && <Fact label="Languages">{detail.languages}</Fact>}
            {detail?.repackSize && <Fact label="Download size">{detail.repackSize}</Fact>}
            {owned?.sizeBytes && installed ? <Fact label="Size on disk">{formatBytes(owned.sizeBytes)}</Fact> : null}
          </div>
        </div>

        {shots.length > 0 && (
          <section className="px-12 pb-8">
            <h3 className="mb-5 text-2xl font-bold">Screenshots</h3>
            <div className={`grid gap-4 ${shots.length === 2 || shots.length === 4 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {shots.map((s, i) => <Screenshot key={s.thumb} shot={s} index={i} onOpen={() => setShot(i)} />)}
            </div>
          </section>
        )}

        {features.length > 0 && (
          <section className="px-12 pb-8">
            <h3 className="mb-4 text-2xl font-bold">Download Details</h3>
            <ul className="selectable space-y-2 text-sm leading-relaxed text-[#d2d2d2]">
              {(showAllFeatures ? features : features.slice(0, 5)).map((f) => (
                <li key={f} className="flex gap-3"><span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-nf-muted" />{f}</li>
              ))}
            </ul>
            {features.length > 5 && (
              <button className="mt-3 flex items-center gap-1 text-sm font-semibold text-nf-secondary hover:text-white" aria-expanded={showAllFeatures} onClick={() => setShowAllFeatures((v) => !v)}>
                <ChevronDown className={`h-4 w-4 transition ${showAllFeatures ? 'rotate-180' : ''}`} />{showAllFeatures ? 'Show less' : `Show all ${features.length}`}
              </button>
            )}
          </section>
        )}

        {(about.length > 0 || (owned && !job)) && (
          <section className="space-y-2 px-12 pb-12 text-sm">
            <h3 className="mb-4 text-2xl">About <span className="font-bold">{info.title}</span></h3>
            {about.map(([label, value]) => <Fact key={label} label={label}>{value}</Fact>)}
            {owned && !job && <Manage game={owned} onRemoved={onClose} onReinstall={() => setInstalling(owned)} />}
          </section>
        )}
      </motion.div>

      {downloading && detail && <DownloadDialog detail={detail} onClose={() => setDownloading(false)} onStarted={() => { onClose(); onOpenLibrary(); }} />}
      {installing && <InstallDialog game={installing} onClose={() => setInstalling(null)} />}
      {shot != null && shots[shot] && <Lightbox shots={shots} index={shot} onIndex={setShot} onClose={() => setShot(null)} />}
    </motion.div>
  );
}
