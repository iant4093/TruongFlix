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
 * folder; the library then picks it up with a scan. People can also search Soulseek themselves and
 * pick a folder: one with the whole album is filed as that album, anything else as it is.
 */

export interface SoulseekStatus {
  state: 'offline' | 'connecting' | 'online' | 'error';
  username: string;
  message: string;
}

export interface AlbumJob {
  id: string;
  /** An album, a folder downloaded as it is, or one song of an imported playlist. */
  kind?: 'album' | 'folder' | 'song';
  /** The playlist import a song belongs to. */
  group?: string | null;
  releaseId: string;
  album: string;
  artist: string;
  cover: string | null;
  state: 'searching' | 'queued' | 'downloading' | 'checking' | 'done' | 'failed' | 'cancelled';
  message: string;
  /** Why a song wasn't found ("no-answer", "not-shared", "quality", "no-match", "blocked"). */
  code?: string | null;
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
      // A playlist's songs are reported (and scanned in) by the import, not one by one.
      if (payload.group) return;
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

let connecting: Promise<SoulseekStatus> | null = null;

/** Waits (up to `ms`) for the app's own reconnect after a dropped connection to finish. */
function settled(ms: number): Promise<SoulseekStatus> {
  return new Promise((resolve) => {
    const done = (status: SoulseekStatus) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(status);
    };
    const timer = setTimeout(() => done(useMusicDownloads.getState().status), ms);
    const unsubscribe = useMusicDownloads.subscribe((s) => {
      if (s.status.state !== 'connecting') done(s.status);
    });
  });
}

/**
 * Logs in to Soulseek with the account from Settings (when not already online). Calls made at
 * the same time share one login; while the app is reconnecting by itself, this waits for that.
 */
export async function connectSoulseek(force = false): Promise<SoulseekStatus> {
  userDisconnected = false;
  await initMusicDownloads();
  const { settings } = useLibraryStore.getState();
  let current = useMusicDownloads.getState().status;
  if (!force && current.state === 'connecting' && !connecting) current = await settled(120_000);
  if (!force && current.state === 'online' && current.username === settings.soulseek_username.trim()) return current;
  if (!hasSoulseekAccount()) throw new Error('Add your Soulseek account in Settings → Music to download albums.');
  if (connecting) return connecting;
  connecting = invoke<SoulseekStatus>('slsk_connect', {
    username: settings.soulseek_username.trim(),
    password: settings.soulseek_password,
    port: settings.soulseek_port,
    shared: settings.soulseek_share ? settings.music_directories : [],
  })
    .then((status) => {
      useMusicDownloads.setState({ status });
      return status;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

/** The user chose Disconnect (and hasn't connected since): imports don't log back in by themselves. */
let userDisconnected = false;
export const disconnectedByUser = () => userDisconnected;

/** Soulseek turned down the account itself (not a network problem): trying again won't help. */
export const loginRefused = (message: string) => /didn.t accept that username|enter your soulseek password/i.test(message);

export async function disconnectSoulseek() {
  userDisconnected = true;
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

/** An audio file in a shared folder found by searching Soulseek. */
export interface SharedFile {
  path: string;
  size: number;
  bitrate: number | null;
  duration: number | null;
  bitDepth: number | null;
}

/** A shared folder found by searching Soulseek: its audio files and who shares it. */
export interface SharedFolder {
  user: string;
  folder: string;
  format: string;
  files: SharedFile[];
  size: number;
  freeSlot: boolean;
  speed: number;
  /** For an album: how many of its songs the folder has. */
  matched: number | null;
}

/** A single shared file, from a search for a song. */
export interface SharedFileHit extends SharedFile {
  user: string;
  freeSlot: boolean;
  speed: number;
  /** It is the song searched for (title, artist, version and length). */
  matches: boolean;
}

/** The song a search by hand is for. */
export interface SongSearch {
  title: string;
  artists: string[];
  album: string | null;
  lengthMs: number | null;
}

export interface SoulseekSearchUpdate {
  folders: SharedFolder[];
  /** For a song: single files instead of folders. */
  files: SharedFileHit[];
  people: number;
  done: boolean;
  /** The phrase Soulseek blocks, when the search contains one (nothing can be found then). */
  blocked: string | null;
}

/** "Starboy" from "Music\\The Weeknd\\Starboy" (either kind of slash). */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A file's path inside its folder ("CD1\\01 - Song.flac"). */
export const pathInFolder = (folder: string, path: string) => path.slice(folder.length).replace(/^[\\/]+/, '');

const tracksOf = (release: CatalogRelease) =>
  release.tracks.map((t) => ({ title: t.title, position: t.position, disc: t.disc, lengthMs: t.lengthMs }));

/**
 * Searches Soulseek for `query` and reports what's found as it arrives (for about 25 seconds).
 * With a release, each folder says how many of its songs it has. Returns a function that stops
 * the search.
 */
export async function searchSoulseek(query: string, release: CatalogRelease | null, onUpdate: (update: SoulseekSearchUpdate) => void, song: SongSearch | null = null): Promise<() => void> {
  await connectSoulseek();
  const id = crypto.randomUUID();
  const unlisten = await listen<SoulseekSearchUpdate & { id: string }>('slsk-search', ({ payload }) => {
    if (payload.id !== id) return;
    onUpdate(payload);
    if (payload.done) unlisten();
  });
  try {
    await invoke('slsk_search', { id, query, tracks: release ? tracksOf(release) : null, song });
  } catch (e) {
    unlisten();
    throw e;
  }
  return () => {
    unlisten();
    void invoke('slsk_search_stop', { id }).catch(() => {});
  };
}

const copyOf = (folder: SharedFolder) => ({ user: folder.user, folder: folder.folder, files: folder.files });

/** Starts downloading `release` (this exact edition and tracklist), from `copy` when the user picked one. */
export async function downloadAlbum(release: CatalogRelease, quality: MusicQuality, copy?: SharedFolder): Promise<AlbumJob> {
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
      copy: copy ? copyOf(copy) : null,
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

/** Downloads a shared folder's audio as it is (its own names and tags) into the music folder's "Soulseek" folder. */
export async function downloadSharedFolder(folder: SharedFolder): Promise<AlbumJob> {
  const destination = downloadFolder();
  if (!destination) throw new Error('Add a music folder in Settings → Music first.');
  await connectSoulseek();
  const job = await invoke<AlbumJob>('slsk_download_folder', { request: { id: crypto.randomUUID(), copy: copyOf(folder), destination } });
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
