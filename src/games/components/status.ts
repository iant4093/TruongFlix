import type { TorrentItem } from '../../types/media';
import type { JobState } from '../jobs';
import type { LibraryGame } from '../types';

const PHASES: Record<JobState['phase'], string> = {
  starting: 'Starting installer',
  installing: 'Installing',
  finalizing: 'Finishing install',
  afterInstall: 'Running after-install steps',
  cleanup: 'Cleaning up',
  verifying: 'Verifying files',
  uninstalling: 'Uninstalling',
  finishing: 'Finishing up',
};

export const isInstalled = (game: LibraryGame) => game.status === 'installed' || game.status === 'verify_failed';

/** Overall progress 0–100 for the current step, or null when it isn't measurable. */
export function gameProgress(game: LibraryGame, job: JobState | undefined, torrent: TorrentItem | undefined): number | null {
  if (job) return job.percent;
  if (game.status === 'downloading') return torrent ? torrent.progressPct : null;
  return null;
}

export function gameStatusLabel(game: LibraryGame, job: JobState | undefined, torrent: TorrentItem | undefined): string {
  if (job) {
    const pct = job.percent != null ? ` ${Math.floor(job.percent)}%` : '…';
    return `${PHASES[job.phase] ?? 'Working'}${pct}`;
  }
  switch (game.status) {
    case 'downloading':
      if (!torrent) return 'Download removed';
      if (torrent.paused) return `Paused ${Math.floor(torrent.progressPct)}%`;
      if (torrent.state === 'resolving' || torrent.state === 'initializing') return 'Connecting…';
      return `Downloading ${Math.floor(torrent.progressPct)}%`;
    case 'downloaded': return 'Ready to install';
    case 'installing': return 'Installing…';
    case 'verifying': return 'Verifying files…';
    case 'installed': return 'Installed';
    case 'install_failed': return 'Install failed';
    case 'verify_failed': return 'Verification failed';
    case 'uninstalling': return 'Uninstalling…';
  }
}

export function formatPlayTime(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? 'Less than a minute' : 'Not played yet';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} hr${hours === 1 ? '' : 's'}${minutes ? ` ${minutes} min` : ''}` : `${minutes} min`;
}
