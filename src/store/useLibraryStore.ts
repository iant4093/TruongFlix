import { create } from 'zustand';
import * as db from '../services/db';
import { setApiKey } from '../services/tmdb';
import type {
  BuiltinPlayerState,
  EpisodeRow,
  MediaItem,
  MovieRow,
  PlaybackState,
  PlayableType,
  PlayerSession,
  PlayerTrack,
  ScanState,
  SeriesRow,
  Settings,
} from '../types/media';
import { buildItems, groupEpisodes } from './selectors';

export type View = 'home' | 'tv' | 'movies' | 'mylist';

export interface HoverState {
  item: MediaItem;
  rect: { top: number; left: number; width: number; height: number };
  /** Optional override (e.g. Continue Watching shows the episode label + progress). */
  subtitle?: string;
  progress?: number;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
}

interface LibraryState {
  ready: boolean;
  settings: Settings;
  movies: MovieRow[];
  series: SeriesRow[];
  episodes: EpisodeRow[];
  episodesBySeries: Map<number, EpisodeRow[]>;
  items: MediaItem[];
  libraryVersion: number;

  view: View;
  search: string;
  detailKey: string | null;
  /** When set, the detail modal shows this episode's page instead of the series overview. */
  detailEpisodeId: number | null;
  fixMatchKey: string | null;
  settingsOpen: boolean;
  onboardingOpen: boolean;
  hover: HoverState | null;

  scan: ScanState;
  playback: PlaybackState;
  toasts: Toast[];
  confirmRequest: ConfirmRequest | null;

  /** Built-in (in-window) player. */
  playerSession: PlayerSession | null;
  playerState: BuiltinPlayerState | null;
  playerTracks: PlayerTrack[];
  setPlayerSession: (s: PlayerSession | null) => void;
  setPlayerState: (s: BuiltinPlayerState | null) => void;
  setPlayerTracks: (t: PlayerTrack[]) => void;

  init: () => Promise<void>;
  /** In-app confirmation dialog; resolves true when the user confirms. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
  reload: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  setView: (v: View) => void;
  setSearch: (q: string) => void;
  openDetail: (key: string | null) => void;
  openEpisode: (id: number | null) => void;
  openFixMatch: (key: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setOnboardingOpen: (open: boolean) => void;
  setHover: (h: HoverState | null) => void;
  setScan: (patch: Partial<ScanState>) => void;
  setPlayback: (patch: Partial<PlaybackState>) => void;
  patchProgress: (type: PlayableType, id: number, time: number, length: number) => void;
  toggleMyList: (item: MediaItem) => Promise<void>;
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

const EMPTY_SCAN: ScanState = { running: false, phase: 'idle', current: 0, total: 0, message: '', added: 0, removed: 0 };

let toastId = 0;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  ready: false,
  settings: {
    tmdb_api_key: '',
    vlc_executable_path: '',
    media_directories: [],
    opensubtitles_api_key: '',
    opensubtitles_username: '',
    opensubtitles_password: '',
    subtitle_language: 'en',
    organize_loose_files: true,
    imdb_enabled: true,
    imdb_last_sync: '',
    player_engine: 'builtin',
    updates_auto_check: true,
    updates_last_check: '',
  },
  movies: [],
  series: [],
  episodes: [],
  episodesBySeries: new Map(),
  items: [],
  libraryVersion: 0,

  view: 'home',
  search: '',
  detailKey: null,
  detailEpisodeId: null,
  fixMatchKey: null,
  settingsOpen: false,
  onboardingOpen: false,
  hover: null,

  scan: EMPTY_SCAN,
  playback: { active: false, type: null, id: null, time: 0, length: 0 },
  toasts: [],
  confirmRequest: null,

  playerSession: null,
  playerState: null,
  playerTracks: [],
  setPlayerSession: (playerSession) => set({ playerSession, hover: null }),
  setPlayerState: (playerState) => set({ playerState }),
  setPlayerTracks: (playerTracks) => set({ playerTracks }),

  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      get().confirmRequest?.resolve(false);
      set({ confirmRequest: { ...opts, resolve } });
    }),
  resolveConfirm: (ok) => {
    const req = get().confirmRequest;
    set({ confirmRequest: null });
    req?.resolve(ok);
  },

  init: async () => {
    const settings = await db.getSettings();
    setApiKey(settings.tmdb_api_key);
    set({ settings });
    await get().reload();
    set({ ready: true, onboardingOpen: !settings.tmdb_api_key || settings.media_directories.length === 0 });
  },

  reload: async () => {
    const { movies, series, episodes } = await db.loadLibrary();
    const episodesBySeries = groupEpisodes(episodes);
    set((s) => ({
      movies,
      series,
      episodes,
      episodesBySeries,
      items: buildItems(movies, series, episodesBySeries),
      libraryVersion: s.libraryVersion + 1,
    }));
  },

  updateSettings: async (patch) => {
    for (const [k, v] of Object.entries(patch)) await db.saveSetting(k as keyof Settings, v as string | string[] | boolean);
    const settings = { ...get().settings, ...patch };
    if (patch.tmdb_api_key !== undefined) setApiKey(settings.tmdb_api_key);
    set({ settings });
  },

  setView: (view) => {
    set({ view, search: '', hover: null });
    window.scrollTo({ top: 0 });
  },
  setSearch: (search) => set({ search, hover: null }),
  openDetail: (detailKey) => set({ detailKey, detailEpisodeId: null, hover: null }),
  openEpisode: (detailEpisodeId) => set({ detailEpisodeId, hover: null }),
  openFixMatch: (fixMatchKey) => set({ fixMatchKey, hover: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen, hover: null }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setHover: (hover) => set({ hover }),
  setScan: (patch) => set((s) => ({ scan: { ...s.scan, ...patch } })),
  setPlayback: (patch) => set((s) => ({ playback: { ...s.playback, ...patch } })),

  /** Live in-memory progress update while VLC is playing (DB is written by the player service). */
  patchProgress: (type, id, time, length) => {
    const { movies, episodes, series, episodesBySeries } = get();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const completed = length > 0 && time / length >= db.COMPLETED_RATIO;
    const counts = time > db.CONTINUE_MIN_SECONDS || completed;
    if (!counts) return;
    const patch = <T extends { progress_seconds: number; duration_seconds: number; watched: number; last_watched_at: string | null }>(r: T): T => ({
      ...r,
      progress_seconds: completed ? 0 : Math.floor(time),
      duration_seconds: Math.round(length),
      watched: completed ? 1 : 0,
      last_watched_at: now,
    });
    if (type === 'movie') {
      const next = movies.map((m) => (m.id === id ? patch(m) : m));
      set({ movies: next, items: buildItems(next, series, episodesBySeries) });
    } else {
      const ep = episodes.find((e) => e.id === id);
      if (!ep) return;
      const nextEps = episodes.map((e) => (e.id === id ? patch(e) : e));
      const nextSeries = series.map((s) => (s.id === ep.series_id ? { ...s, last_watched_at: now } : s));
      const grouped = groupEpisodes(nextEps);
      set({ episodes: nextEps, series: nextSeries, episodesBySeries: grouped, items: buildItems(movies, nextSeries, grouped) });
    }
  },

  toggleMyList: async (item) => {
    await db.setMyList(item.kind, item.id, !item.myList);
    await get().reload();
    get().toast(item.myList ? `Removed “${item.title}” from My List` : `Added “${item.title}” to My List`, 'success');
  },

  toast: (message, kind = 'info') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const selectItem = (key: string | null) => (s: LibraryState) => (key ? (s.items.find((i) => i.key === key) ?? null) : null);
