import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import * as db from '../services/db';
import { onTorrentCompleted, pollTorrents, syncTorrentEngineConfig } from '../services/torrents';
import { useLibraryStore } from '../store/useLibraryStore';
import type { TorrentItem, TorrentStatus } from '../types/media';
import { buildInstallJob, buildOptions, chooseLanguage, defaultChoices, resolvePath } from './installerOptions';
import * as lib from './library';
import type { GameDetail, GameSettings, InstallChoices, InstallerInfo, KnownFolders, LibraryGame } from './types';

export type JobPhase = 'starting' | 'installing' | 'finalizing' | 'afterInstall' | 'cleanup' | 'verifying' | 'uninstalling' | 'finishing';

export interface JobState {
  phase: JobPhase;
  percent: number | null;
  status: string;
  jobId: string;
}

interface HelperEvent {
  type: 'phase' | 'progress' | 'error' | 'done';
  phase?: string;
  percent?: number;
  status?: string;
  message?: string;
  cancelled?: boolean;
}

interface VerifyProgress { doneBytes: number; totalBytes: number; filesDone: number; filesTotal: number; current: string }
interface VerifyResult { available: boolean; filesChecked: number; mismatched: string[]; missing: string[] }

interface GamesState {
  ready: boolean;
  games: LibraryGame[];
  settings: GameSettings;
  jobs: Record<number, JobState>;
  running: Record<number, boolean>;
  /** Files that failed verification, per game. */
  verifyFailures: Record<number, string[]>;
}

export const useGamesStore = create<GamesState>(() => ({
  ready: false,
  games: [],
  settings: { ...lib.DEFAULT_GAME_SETTINGS },
  jobs: {},
  running: {},
  verifyFailures: {},
}));

const toast = (message: string, kind: 'info' | 'success' | 'error' = 'info') => useLibraryStore.getState().toast(message, kind);

async function refresh() {
  useGamesStore.setState({ games: await lib.listGames() });
}

function setJob(gameId: number, job: JobState | null) {
  useGamesStore.setState((s) => {
    const jobs = { ...s.jobs };
    if (job) jobs[gameId] = job;
    else delete jobs[gameId];
    return { jobs };
  });
}

async function patchGame(id: number, patch: lib.GamePatch) {
  await lib.updateGame(id, patch);
  await refresh();
}

const gameById = (id: number) => useGamesStore.getState().games.find((g) => g.id === id) ?? null;

let knownFolders: KnownFolders | null = null;
async function folders(): Promise<KnownFolders> {
  knownFolders ??= await invoke<KnownFolders>('games_known_folders');
  return knownFolders;
}

export function joinPath(dir: string, leaf: string) {
  return `${dir.replace(/[\\/]+$/, '')}\\${leaf.replace(/^[\\/]+/, '')}`;
}

export function folderName(title: string) {
  return title.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').trim() || 'Game';
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let initialized: Promise<void> | null = null;

export function initGames(): Promise<void> {
  initialized ??= (async () => {
    const [settings, games] = await Promise.all([lib.loadGameSettings(), lib.listGames()]);
    useGamesStore.setState({ settings, games, ready: true });

    // Jobs can't survive an app restart; the installer was closed with the app.
    for (const g of games) {
      if (g.status === 'installing' || g.status === 'verifying') {
        await lib.updateGame(g.id, { status: 'install_failed', error: 'TruongFlix was closed during installation. Install again to finish.' });
      } else if (g.status === 'uninstalling') {
        await lib.updateGame(g.id, { status: 'installed', error: 'TruongFlix was closed while uninstalling. Try again.' });
      }
    }
    await refresh();

    onTorrentCompleted((t) => void onDownloadComplete(t));
    await listen<{ jobId: string; event: HelperEvent }>('games-job', (e) => onHelperEvent(e.payload.jobId, e.payload.event));
    await listen<{ jobId: string; progress: VerifyProgress }>('games-verify', (e) => onVerifyProgress(e.payload.jobId, e.payload.progress));
    await listen<{ gameId: string; seconds: number; error: string | null }>('games-session', (e) => void onSessionEnded(e.payload));

    // Downloads that finished while this screen wasn't loaded yet.
    const torrents = useLibraryStore.getState().torrents;
    for (const g of useGamesStore.getState().games) {
      if (g.status !== 'downloading' || !g.infoHash) continue;
      const t = torrents.find((x) => x.infoHash === g.infoHash);
      if (t?.finished) await onDownloadComplete(t);
    }
  })();
  initialized.catch(() => (initialized = null));
  return initialized;
}

export async function updateGameSettings(patch: Partial<GameSettings>) {
  await lib.saveGameSettings(patch);
  useGamesStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface DownloadRequest {
  detail: GameDetail;
  downloadDir: string;
  onlyFiles: number[] | null;
  autoInstall: boolean;
  deleteInstaller: boolean;
  stopSeedingWhenDone: boolean;
}

export async function downloadGame(req: DownloadRequest): Promise<LibraryGame> {
  if (!req.detail.magnet) throw new Error('This game has no torrent download.');
  await syncTorrentEngineConfig();
  const status = await invoke<TorrentStatus>('torrent_add', {
    req: {
      source: req.detail.magnet,
      is_stream: false,
      output_folder: req.downloadDir,
      sub_folder: folderName(req.detail.title),
      only_files: req.onlyFiles,
      paused: false,
      initial_peers: null,
    },
  });
  await db.upsertTorrentRecord({
    info_hash: status.info_hash,
    name: status.name || req.detail.title,
    source: req.detail.magnet,
    mode: 'download',
    purpose: 'game',
    save_path: status.output_folder,
    delete_on_complete: req.stopSeedingWhenDone,
    cache_hours: null,
    expires_at: null,
    media_kind: null,
    tmdb_id: null,
    series_id: null,
    movie_id: null,
    file_paths: [],
    total_bytes: status.total_bytes,
    completed_at: status.finished ? new Date().toISOString() : null,
    seeding_stopped: false,
  });
  const game = await lib.insertGame({
    slug: req.detail.slug,
    title: req.detail.title,
    subtitle: req.detail.subtitle,
    cover: req.detail.cover,
    detail: req.detail,
    status: 'downloading',
    infoHash: status.info_hash,
    installerDir: null,
    autoInstall: req.autoInstall,
    deleteInstaller: req.deleteInstaller,
    choices: null,
  });
  await refresh();
  await pollTorrents();
  toast(`Downloading “${req.detail.title}”`, 'success');
  return game;
}

/** The folder holding the installer, from the finished torrent's file list. */
function installerFolder(t: TorrentItem): string | null {
  const setup = t.files.find((f) => /^setup.*\.exe$/i.test(f.name) && f.included);
  if (setup) return setup.full_path.replace(/[\\/][^\\/]+$/, '');
  return t.savePath || null;
}

async function onDownloadComplete(t: TorrentItem) {
  if (t.purpose !== 'game') return;
  await initGames();
  const game = useGamesStore.getState().games.find((g) => g.infoHash === t.infoHash);
  if (!game || game.status !== 'downloading') return;
  const installerDir = installerFolder(t);
  await patchGame(game.id, { status: 'downloaded', installerDir, error: null });
  if (game.autoInstall) {
    void installGame(game.id).catch((e) => toast(String(e), 'error'));
  } else {
    toast(`“${game.title}” finished downloading and is ready to install.`, 'success');
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function inspectInstaller(installerDir: string): Promise<InstallerInfo> {
  return invoke<InstallerInfo>('games_inspect_installer', { dir: installerDir });
}

/** Install choices TruongFlix uses when installing automatically. */
export async function automaticChoices(info: InstallerInfo, game: LibraryGame): Promise<InstallChoices> {
  const { settings } = useGamesStore.getState();
  const language = chooseLanguage(info, [...navigator.languages]);
  const options = buildOptions(info, language, missingOptionalFor(game));
  const totalRamGb = await invoke<number>('games_total_memory_gb').catch(() => 16);
  return defaultChoices(info, options, {
    language,
    installRoot: settings.installDir,
    installRedists: settings.installRedists,
    desktopShortcut: settings.desktopShortcut,
    totalRamGb,
  });
}

/** Optional repack files the user chose not to download. */
export function missingOptionalFor(game: LibraryGame): string[] {
  const t = useLibraryStore.getState().torrents.find((x) => x.infoHash === game.infoHash);
  if (!t) return [];
  return t.files
    .filter((f) => !f.included && /^(fg-)?(optional|selective)-/i.test(f.name))
    .map((f) => f.name.replace(/\.bin$/i, '').replace(/[-.]part\d+$/i, ''));
}

const jobOwners = new Map<string, number>();
const jobErrors = new Map<string, string>();
const jobCancelled = new Set<string>();

function onHelperEvent(jobId: string, event: HelperEvent) {
  const gameId = jobOwners.get(jobId);
  if (gameId == null) return;
  const current = useGamesStore.getState().jobs[gameId];
  if (event.type === 'phase' && event.phase) {
    setJob(gameId, { jobId, phase: event.phase as JobPhase, percent: current?.percent ?? null, status: current?.status ?? '' });
  } else if (event.type === 'progress') {
    setJob(gameId, { jobId, phase: current?.phase ?? 'installing', percent: event.percent ?? null, status: event.status ?? '' });
  } else if (event.type === 'error' && event.message) {
    jobErrors.set(jobId, event.message);
  } else if (event.type === 'done' && event.cancelled) {
    jobCancelled.add(jobId);
  }
}

function onVerifyProgress(jobId: string, p: VerifyProgress) {
  const gameId = jobOwners.get(jobId);
  if (gameId == null) return;
  const percent = p.totalBytes > 0 ? (p.doneBytes / p.totalBytes) * 100 : 0;
  setJob(gameId, { jobId, phase: 'verifying', percent, status: `${p.filesDone} of ${p.filesTotal} files · ${p.current}` });
}

function newJobId(gameId: number) {
  return `game-${gameId}-${Date.now().toString(36)}`;
}

/** The game's program, from the installer's shortcuts, else the most likely exe in its folder. */
async function findGameExe(info: InstallerInfo | null, installDir: string): Promise<string | null> {
  if (info) {
    const f = await folders();
    const ctx = { app: installDir, src: '', folders: f };
    const fromIcons = info.icons
      .map((i) => i.filename)
      .filter((p) => /^\{app\}\\.+\.exe$/i.test(p) && !/unins/i.test(p));
    const fromRun = info.runEntries
      .filter((r) => /\{cm:LaunchProgram/i.test(r.description) || r.skipIfSilent)
      .map((r) => r.filename)
      .filter((p) => /^\{app\}\\.+\.exe$/i.test(p));
    for (const candidate of [...fromIcons, ...fromRun]) {
      const path = resolvePath(candidate, ctx);
      const ok = await invoke<boolean[]>('check_paths', { paths: [path] }).catch(() => [false]);
      if (ok[0]) return path;
    }
  }
  const found = await invoke<{ path: string; size: number }[]>('games_find_executables', { installDir }).catch(() => []);
  return found[0]?.path ?? null;
}

async function removeInstaller(game: LibraryGame) {
  if (game.infoHash) {
    await invoke('torrent_action', { infoHash: game.infoHash, action: 'delete_keep_files' }).catch(() => {});
  }
  // Rust deletes the folder recorded for the game (its torrent's, else the installer's), so the
  // torrent record is only dropped afterwards.
  if ((game.infoHash || game.installerDir) && useGamesStore.getState().settings.downloadDir) {
    await invoke('games_delete_folder', { gameId: game.id }).catch((e) =>
      toast(`The installer couldn't be deleted: ${String(e)}`, 'error'),
    );
  }
  if (game.infoHash) await db.deleteTorrentRecord(game.infoHash);
  await lib.updateGame(game.id, { installerDir: null, infoHash: null });
  await pollTorrents();
}

/** Installs a downloaded game with the given choices (or the automatic defaults). */
export async function installGame(gameId: number, chosen?: InstallChoices, inspected?: InstallerInfo): Promise<void> {
  const game = gameById(gameId);
  if (!game?.installerDir) throw new Error('The installer for this game was not found.');
  if (useGamesStore.getState().jobs[gameId]) return;
  const jobId = newJobId(gameId);
  jobOwners.set(jobId, gameId);
  setJob(gameId, { jobId, phase: 'starting', percent: null, status: 'Waiting for Windows permission…' });
  try {
    const info = inspected ?? (await inspectInstaller(game.installerDir));
    const choices = chosen ?? (await automaticChoices(info, game));
    if (!choices.installDir) throw new Error('Choose a folder for installed games in Games › Games settings.');
    const options = buildOptions(info, choices.language, missingOptionalFor(game));
    const job = buildInstallJob(info, options, choices, { folders: await folders() });
    await patchGame(gameId, { status: 'installing', choices, installDir: choices.installDir, error: null });

    const ok = await invoke<boolean>('games_install', { jobId, gameId, job });
    if (!ok) {
      if (jobCancelled.has(jobId)) {
        await patchGame(gameId, { status: 'downloaded', installDir: null, error: null });
        toast(`Canceled installing “${game.title}”`, 'info');
      } else {
        await patchGame(gameId, { status: 'install_failed', error: jobErrors.get(jobId) ?? 'The installer stopped before finishing.' });
      }
      return;
    }

    setJob(gameId, { jobId, phase: 'verifying', percent: 0, status: 'Checking installed files…' });
    await patchGame(gameId, { status: 'verifying' });
    const result = await invoke<VerifyResult>('games_verify', { jobId, installDir: choices.installDir });
    const bad = [...result.mismatched.map((f) => `${f} (damaged)`), ...result.missing.map((f) => `${f} (missing)`)];

    setJob(gameId, { jobId, phase: 'finishing', percent: null, status: 'Finishing up…' });
    const exePath = await findGameExe(info, choices.installDir);
    const sizeBytes = await invoke<number>('games_folder_size', { dir: choices.installDir }).catch(() => null);
    if (bad.length) {
      useGamesStore.setState((s) => ({ verifyFailures: { ...s.verifyFailures, [gameId]: bad } }));
      await patchGame(gameId, {
        status: 'verify_failed',
        exePath,
        sizeBytes,
        installedAt: new Date().toISOString(),
        error: `${bad.length} file${bad.length === 1 ? '' : 's'} didn't match. The installer was kept so you can reinstall.`,
      });
      toast(`“${game.title}” installed, but some files didn't verify.`, 'error');
      return;
    }
    await patchGame(gameId, { status: 'installed', exePath, sizeBytes, installedAt: new Date().toISOString(), error: null });
    if (game.deleteInstaller) await removeInstaller(gameById(gameId) ?? game);
    await refresh();
    toast(`“${game.title}” is ready to play${result.available ? ' — all files verified' : ''}.`, 'success');
  } catch (e) {
    await patchGame(gameId, { status: game.installDir && game.status === 'installed' ? 'installed' : 'install_failed', error: String(e) });
    throw e;
  } finally {
    setJob(gameId, null);
    jobOwners.delete(jobId);
    jobErrors.delete(jobId);
    jobCancelled.delete(jobId);
  }
}

export async function cancelJob(gameId: number) {
  const job = useGamesStore.getState().jobs[gameId];
  if (job) await invoke('games_cancel', { jobId: job.jobId });
}

// ---------------------------------------------------------------------------
// Library actions
// ---------------------------------------------------------------------------

export async function launchGame(gameId: number) {
  const game = gameById(gameId);
  if (!game?.exePath || !game.installDir) throw new Error('Choose the game’s program file first.');
  if (useGamesStore.getState().running[gameId]) return;
  await invoke('games_launch', { gameId });
  useGamesStore.setState((s) => ({ running: { ...s.running, [gameId]: true } }));
}

async function onSessionEnded(e: { gameId: string; seconds: number; error: string | null }) {
  const id = Number(e.gameId);
  useGamesStore.setState((s) => {
    const running = { ...s.running };
    delete running[id];
    return { running };
  });
  if (e.error) toast(e.error, 'error');
  const game = gameById(id);
  if (e.seconds > 0) {
    await lib.addPlayTime(id, e.seconds);
    if (game) await lib.recordPlaySession(game, e.seconds).catch(() => {});
  }
  await refresh();
}

export async function setGameExe(gameId: number, exePath: string) {
  await patchGame(gameId, { exePath });
}

export async function uninstallGame(gameId: number) {
  const game = gameById(gameId);
  if (!game?.installDir) return;
  const jobId = newJobId(gameId);
  jobOwners.set(jobId, gameId);
  setJob(gameId, { jobId, phase: 'uninstalling', percent: null, status: 'Waiting for Windows permission…' });
  try {
    await patchGame(gameId, { status: 'uninstalling' });
    const ok = await invoke<boolean>('games_uninstall', { jobId, gameId });
    if (!ok) {
      await patchGame(gameId, { status: 'installed', error: jobErrors.get(jobId) ?? 'Uninstall did not finish.' });
      return;
    }
    if (game.installerDir) {
      await patchGame(gameId, { status: 'downloaded', installDir: null, exePath: null, sizeBytes: null, installedAt: null, error: null });
    } else {
      await lib.deleteGame(gameId);
      await refresh();
    }
    toast(`Uninstalled “${game.title}”`, 'success');
  } catch (e) {
    await patchGame(gameId, { status: 'installed', error: String(e) });
    throw e;
  } finally {
    setJob(gameId, null);
    jobOwners.delete(jobId);
    jobErrors.delete(jobId);
  }
}

/** Removes a game from the library (and cancels/deletes its download if it never installed). */
export async function removeGame(gameId: number, deleteDownload: boolean) {
  const game = gameById(gameId);
  if (!game) return;
  if (deleteDownload && game.infoHash) {
    await removeInstaller(game);
  }
  await lib.deleteGame(gameId);
  await refresh();
}

export async function deleteInstallerNow(gameId: number) {
  const game = gameById(gameId);
  if (game) await removeInstaller(game);
  await refresh();
}

export async function retryDownload(gameId: number) {
  const game = gameById(gameId);
  if (!game?.detail) return;
  const { settings } = useGamesStore.getState();
  await downloadGame({
    detail: game.detail,
    downloadDir: settings.downloadDir,
    onlyFiles: null,
    autoInstall: game.autoInstall,
    deleteInstaller: game.deleteInstaller,
    stopSeedingWhenDone: useLibraryStore.getState().settings.torrent_delete_after_complete,
  });
}
