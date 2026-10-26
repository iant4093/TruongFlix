import { create } from 'zustand';
import * as db from '../services/db';
import { setApiKey } from '../services/tmdb';
import type {
  BuiltinPlayerState,
  CollectionRow,
  EpisodeRow,
  MediaItem,
  MovieRow,
  PlaybackState,
  PlayableType,
  PlayerSession,
  PlayerTrack,
  Profile,
  ScanState,
  SeriesRow,
  Settings,
  SleepTimer,
} from '../types/media';
import { allowedForMaturity, buildItems, groupEpisodes } from './selectors';

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

export interface ActorRef {
  name: string;
  id?: number;
  profile?: string | null;
}

export interface AnalysisState {
  running: boolean;
  message: string;
}

export interface PinRequest {
  title: string;
  subtitle?: string;
  check: (pin: string) => boolean;
  then: () => void;
}

export type Overlay = 'wrapped' | 'history' | 'rename' | 'health' | null;

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
  /** Every item, ignoring the active profile's maturity filter. */
  allItems: MediaItem[];
  collections: CollectionRow[];
  libraryVersion: number;

  profiles: Profile[];
  activeProfile: Profile | null;
  /** "Who's watching?" screen (also used for managing profiles). */
  profileGate: 'select' | 'manage' | null;
  actor: ActorRef | null;
  overlay: Overlay;
  playerMini: boolean;
  sleepTimer: SleepTimer | null;
  pinRequest: PinRequest | null;
  /** The speakers the player is using right now (resolved from "System default"). */
  audioOutput: { key: string; label: string } | null;
  /** What's showing over the player: "Are you still watching?" or "Sleep timer ended". */
  playerPrompt: 'still-watching' | 'sleep-ended' | 'limit' | 'bedtime' | null;
  analysis: AnalysisState;

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
  playerChapters: { title: string; time: number }[];
  setPlayerSession: (s: PlayerSession | null) => void;
  setPlayerState: (s: BuiltinPlayerState | null) => void;
  setPlayerTracks: (t: PlayerTrack[]) => void;
  setPlayerChapters: (c: { title: string; time: number }[]) => void;

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
  loadProfiles: () => Promise<void>;
  switchProfile: (id: number) => Promise<void>;
  setProfileGate: (g: 'select' | 'manage' | null) => void;
  openActor: (a: ActorRef | null) => void;
  setOverlay: (o: Overlay) => void;
  setPlayerMini: (mini: boolean) => void;
  setSleepTimer: (t: SleepTimer | null) => void;
  setPinRequest: (r: PinRequest | null) => void;
  setAudioOutput: (o: { key: string; label: string } | null) => void;
  setPlayerPrompt: (p: 'still-watching' | 'sleep-ended' | 'limit' | 'bedtime' | null) => void;
  setAnalysis: (a: AnalysisState) => void;
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
    subtitle_style: { size: 'medium', color: 'white', background: 'shadow', font: 'sans' },
    audio_night: false,
    audio_dialogue: false,
    intro_detection: true,
    skip_intro_auto: false,
    watch_folders: true,
    trailers_autoplay: true,
    launch_intro: true,
    launch_intro_sound: true,
    hover_stills: true,
    ask_profile: true,
    active_profile: 0,
    still_watching_after: 3,
    audio_device: 'auto',
    audio_passthrough: false,
    audio_delays: {},
    pause_on_lock: true,
    omdb_api_key: '',
    network_shares: {},
  },
  movies: [],
  series: [],
  episodes: [],
  episodesBySeries: new Map(),
  items: [],
  allItems: [],
  collections: [],
  libraryVersion: 0,

  profiles: [],
  activeProfile: null,
  profileGate: null,
  actor: null,
  overlay: null,
  playerMini: false,
  sleepTimer: null,
  pinRequest: null,
  audioOutput: null,
  playerPrompt: null,
  analysis: { running: false, message: '' },

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
  playerChapters: [],
  setPlayerSession: (playerSession) => set({ playerSession, hover: null }),
  setPlayerState: (playerState) => set({ playerState }),
  setPlayerTracks: (playerTracks) => set({ playerTracks }),
  setPlayerChapters: (playerChapters) => set({ playerChapters }),

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
    const profiles = await db.listProfiles();
    const active = profiles.find((p) => p.id === settings.active_profile) ?? profiles[0] ?? null;
    if (active) db.setActiveProfile(active.id);
    set({ profiles, activeProfile: active });
    await get().reload();
    const onboarding = !settings.tmdb_api_key || settings.media_directories.length === 0;
    set({
      ready: true,
      onboardingOpen: onboarding,
      // A PIN-protected profile never opens without its PIN.
      profileGate: !onboarding && ((settings.ask_profile && profiles.length > 1) || !!active?.pin) ? 'select' : null,
    });
  },

  reload: async () => {
    const [{ movies, series, episodes }, collections] = await Promise.all([db.loadLibrary(), db.listCollections()]);
    const episodesBySeries = groupEpisodes(episodes);
    const all = buildItems(movies, series, episodesBySeries);
    const maturity = get().activeProfile?.maturity ?? 'all';
    set((s) => ({
      movies,
      series,
      episodes,
      episodesBySeries,
      allItems: all,
      collections,
      items: all.filter((i) => allowedForMaturity(i, maturity)),
      libraryVersion: s.libraryVersion + 1,
    }));
  },

  loadProfiles: async () => {
    const profiles = await db.listProfiles();
    const current = get().activeProfile;
    set({ profiles, activeProfile: profiles.find((p) => p.id === current?.id) ?? profiles[0] ?? null });
  },

  switchProfile: async (id) => {
    const profile = get().profiles.find((p) => p.id === id);
    if (!profile) return;
    db.setActiveProfile(id);
    await db.saveSetting('active_profile', id);
    set((s) => ({ activeProfile: profile, settings: { ...s.settings, active_profile: id }, profileGate: null, view: 'home', search: '', detailKey: null }));
    await get().reload();
    window.scrollTo({ top: 0 });
  },

  setProfileGate: (profileGate) => set({ profileGate, hover: null }),
  openActor: (actor) => set({ actor, hover: null }),
  setOverlay: (overlay) => set({ overlay, hover: null }),
  setPlayerMini: (playerMini) => set({ playerMini, hover: null }),
  setSleepTimer: (sleepTimer) => set({ sleepTimer }),
  setPinRequest: (pinRequest) => set({ pinRequest }),
  setAudioOutput: (audioOutput) => set({ audioOutput }),
  setPlayerPrompt: (playerPrompt) => set({ playerPrompt }),
  setAnalysis: (analysis) => set({ analysis }),

  updateSettings: async (patch) => {
    for (const [k, v] of Object.entries(patch)) await db.saveSetting(k as keyof Settings, v as string | string[] | boolean | number | object);
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
    const maturity = get().activeProfile?.maturity ?? 'all';
    const filtered = (all: MediaItem[]) => ({ allItems: all, items: all.filter((i) => allowedForMaturity(i, maturity)) });
    if (type === 'movie') {
      const next = movies.map((m) => (m.id === id ? patch(m) : m));
      set({ movies: next, ...filtered(buildItems(next, series, episodesBySeries)) });
    } else {
      const ep = episodes.find((e) => e.id === id);
      if (!ep) return;
      const nextEps = episodes.map((e) => (e.id === id ? patch(e) : e));
      const nextSeries = series.map((s) => (s.id === ep.series_id ? { ...s, last_watched_at: now } : s));
      const grouped = groupEpisodes(nextEps);
      set({ episodes: nextEps, series: nextSeries, episodesBySeries: grouped, ...filtered(buildItems(movies, nextSeries, grouped)) });
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
