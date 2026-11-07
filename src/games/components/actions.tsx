import { useState } from 'react';
import { Download, Gamepad2, Loader2, Pause, Play, RotateCcw, X } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { pauseTorrent, resumeTorrent } from '../../services/torrents';
import { cancelJob, launchGame, retryDownload, useGamesStore } from '../jobs';
import type { GameDetail, LibraryGame } from '../types';
import { gameStatusLabel, isInstalled } from './status';

export const toastError = (e: unknown) => useLibraryStore.getState().toast(e instanceof Error ? e.message : String(e), 'error');

/** The library entry, install job, running state and torrent for a game, all live. */
export function useOwnedGame(slug: string) {
  const owned = useGamesStore((s) => s.games.find((g) => g.slug === slug));
  const job = useGamesStore((s) => (owned ? s.jobs[owned.id] : undefined));
  const running = useGamesStore((s) => (owned ? !!s.running[owned.id] : false));
  const torrent = useLibraryStore((s) => (owned?.infoHash ? s.torrents.find((t) => t.infoHash === owned.infoHash) : undefined));
  return { owned, job, running, torrent };
}

/** Runs one action at a time and shows failures as a toast. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return { busy, run };
}

export const hasInstaller = (game: LibraryGame) => !!game.installerDir && game.status !== 'downloading';

/** The one main action for a game: Play, Download, Install, Pause/Resume download or Cancel install. */
export function PrimaryAction({ slug, detail, onDownload, onInstall, size = 'lg' }: {
  slug: string;
  detail: GameDetail | null;
  onDownload: () => void;
  onInstall: (game: LibraryGame) => void;
  size?: 'lg' | 'xl';
}) {
  const { owned, job, running, torrent } = useOwnedGame(slug);
  const { busy, run } = useBusy();
  const icon = size === 'xl' ? 'h-7 w-7' : 'h-6 w-6';
  const play = `nf-btn-play text-lg disabled:cursor-not-allowed disabled:opacity-50 ${size === 'lg' ? 'px-8' : ''}`;
  const info = `nf-btn-info text-lg disabled:cursor-not-allowed disabled:opacity-50 ${size === 'lg' ? 'px-8' : ''}`;

  if (owned && job) {
    return <button className={info} disabled={busy || !['starting', 'installing', 'finalizing'].includes(job.phase)} onClick={() => void run(() => cancelJob(owned.id))}>
      <X className={icon} />Cancel install
    </button>;
  }
  if (owned && isInstalled(owned)) {
    return <button className={play} disabled={running || busy || !owned.exePath} onClick={() => void run(() => launchGame(owned.id))}>
      <Play className={`${icon} fill-black`} strokeWidth={0} />{running ? 'Playing' : 'Play'}
    </button>;
  }
  if (owned?.status === 'downloading') {
    if (!torrent) {
      return <button className={play} disabled={busy} onClick={() => void run(() => retryDownload(owned.id))}><RotateCcw className={icon} />Download again</button>;
    }
    return torrent.paused
      ? <button className={play} disabled={busy} onClick={() => void run(() => resumeTorrent(torrent.infoHash))}><Play className={`${icon} fill-black`} strokeWidth={0} />Resume download</button>
      : <button className={info} disabled={busy} onClick={() => void run(() => pauseTorrent(torrent.infoHash))}><Pause className={`${icon} fill-white`} strokeWidth={0} />Pause download</button>;
  }
  if (owned && hasInstaller(owned)) {
    return <button className={play} disabled={busy} onClick={() => onInstall(owned)}>
      <Gamepad2 className={icon} />{owned.status === 'downloaded' ? 'Install' : 'Install again'}
    </button>;
  }
  if (owned?.status === 'install_failed') {
    return <button className={play} disabled={busy || !owned.detail} onClick={() => void run(() => retryDownload(owned.id))}><RotateCcw className={icon} />Download again</button>;
  }
  if (owned) {
    return <button className={info} disabled><Loader2 className={`${icon} animate-spin`} />{gameStatusLabel(owned, job, torrent)}</button>;
  }
  return <button className={play} disabled={!detail?.magnet} onClick={onDownload}>
    {detail ? <Download className={icon} /> : <Loader2 className={`${icon} animate-spin`} />}Download
  </button>;
}
