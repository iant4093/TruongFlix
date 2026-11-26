import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { useLibraryStore } from '../store/useLibraryStore';
import { runMusicScan } from './music';
import type { CatalogRelease } from './musicCatalog';
import type { MusicQuality } from '../types/media';

/**
 * Album downloads from Soulseek: the session (logged in with the account from Settings → Music,
 * only when needed), the download jobs and their progress. The app finds a complete copy of the
 * exact edition shown, downloads only its audio, checks and tags it, and files it into the music
 * folder; the library then picks it up with a scan.
 */

export interface SoulseekStatus {
  state: 'offline' | 'connecting' | 'online' | 'error';
  username: string;
  message: string;
}

export interface AlbumJob {
  id: string;
  releaseId: string;
  album: string;
  artist: string;
  cover: string | null;
  state: 'searching' | 'queued' | 'downloading' | 'checking' | 'done' | 'failed' | 'cancelled';
  message: string;
  bytes: number;
  total: number;
  filesDone: number;
  filesTotal: number;
  source: { user: string; format: string } | null;
  path: string | null;
}

interface DownloadsState {
  status: SoulseekStatus;
  jobs: Record<string, AlbumJob>;
}

export const useMusicDownloads = create<DownloadsState>(() => ({
  status: { state: 'offline', username: '', message: '' },
  jobs: {},
}));

export const isActive = (job: AlbumJob) => !['done', 'failed', 'cancelled'].includes(job.state);

let started: Promise<void> | null = null;

/** Starts following Soulseek status and download progress (once). */
export function initMusicDownloads(): Promise<void> {
  if (started) return started;
  started = (async () => {
    await listen<SoulseekStatus>('slsk-status', ({ payload }) => useMusicDownloads.setState({ status: payload }));
    await listen<AlbumJob>('slsk-job', ({ payload }) => {
      const before = useMusicDownloads.getState().jobs[payload.id];
      useMusicDownloads.setState((s) => ({ jobs: { ...s.jobs, [payload.id]: payload } }));
      if (payload.state === 'done' && before?.state !== 'done') {
        useLibraryStore.getState().toast(`${payload.album} is in your music library`, 'success');
        void runMusicScan();
      } else if (payload.state === 'failed' && before?.state !== 'failed') {
        useLibraryStore.getState().toast(`${payload.album}: ${payload.message}`, 'error');
      }
    });
    const [status, jobs] = await Promise.all([invoke<SoulseekStatus>('slsk_status'), invoke<AlbumJob[]>('slsk_jobs')]);
    useMusicDownloads.setState((s) => ({ status, jobs: { ...Object.fromEntries(jobs.map((j) => [j.id, j])), ...s.jobs } }));
  })().catch((e) => {
    started = null;
    throw e;
  });
  return started;
}

export const hasSoulseekAccount = () => {
  const { soulseek_username, soulseek_password } = useLibraryStore.getState().settings;
  return !!soulseek_username.trim() && !!soulseek_password;
};

/** Logs in to Soulseek with the account from Settings (when not already online). */
export async function connectSoulseek(force = false): Promise<SoulseekStatus> {
  await initMusicDownloads();
  const current = useMusicDownloads.getState().status;
  const { settings } = useLibraryStore.getState();
  if (!force && current.state === 'online' && current.username === settings.soulseek_username.trim()) return current;
  if (!hasSoulseekAccount()) throw new Error('Add your Soulseek account in Settings → Music to download albums.');
  const status = await invoke<SoulseekStatus>('slsk_connect', {
    username: settings.soulseek_username.trim(),
    password: settings.soulseek_password,
    port: settings.soulseek_port,
    shared: settings.soulseek_share ? settings.music_directories : [],
  });
  useMusicDownloads.setState({ status });
  return status;
}

export async function disconnectSoulseek() {
  await invoke('slsk_disconnect');
  useMusicDownloads.setState({ status: { state: 'offline', username: '', message: '' } });
}

/** The music folder downloads are filed into. */
export function downloadFolder(): string | null {
  const { music_download_dir, music_directories } = useLibraryStore.getState().settings;
  if (music_download_dir && music_directories.includes(music_download_dir)) return music_download_dir;
  return music_directories[0] ?? null;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Starts downloading `release` (this exact edition and tracklist). */
export async function downloadAlbum(release: CatalogRelease, quality: MusicQuality): Promise<AlbumJob> {
  const destination = downloadFolder();
  if (!destination) throw new Error('Add a music folder in Settings → Music first.');
  if (!release.tracks.length) throw new Error('The store doesn’t list this album’s songs.');
  await connectSoulseek();
  // The cover is fetched once (and cached) so it can be embedded in every file.
  const coverPath = release.cover ? await invoke<string>('live_artwork', { url: release.cover }).catch(() => null) : null;
  const id = crypto.randomUUID();
  const job = await invoke<AlbumJob>('slsk_download_album', {
    request: {
      id,
      releaseId: release.id,
      coverUrl: release.cover,
      album: release.title,
      albumArtist: release.artist,
      date: release.date,
      genre: release.genres[0] ? titleCase(release.genres[0]) : null,
      tracks: release.tracks.map((t) => ({
        title: t.title,
        position: t.position,
        disc: t.disc,
        lengthMs: t.lengthMs,
        artist: t.artist,
      })),
      quality,
      destination,
      coverPath,
    },
  });
  useMusicDownloads.setState((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
  return job;
}

export const cancelAlbumJob = (id: string) => invoke('slsk_cancel', { id });

export async function dismissAlbumJob(id: string) {
  await invoke('slsk_dismiss', { id });
  useMusicDownloads.setState((s) => {
    const jobs = { ...s.jobs };
    delete jobs[id];
    return { jobs };
  });
}

export const jobLabel = (job: AlbumJob) =>
  ({
    searching: 'Searching Soulseek…',
    queued: job.source ? `Waiting for ${job.source.user}` : 'Waiting in line',
    downloading: `Downloading ${job.filesDone}/${job.filesTotal}`,
    checking: 'Checking and tagging',
    done: 'In your library',
    failed: 'Couldn’t download',
    cancelled: 'Cancelled',
  })[job.state];
