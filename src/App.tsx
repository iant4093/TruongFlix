import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion, useIsPresent } from 'framer-motion';
import { SectionMemory } from './lib/sectionMemory';
import { fade } from './lib/motion';
import { useLibraryStore } from './store/useLibraryStore';
import Navbar, { Wordmark } from './components/layout/Navbar';
import { BrowseView, MyListView, SearchView } from './components/home/Browse';
import HoverPreview from './components/home/HoverPreview';
import Toasts from './components/common/Toasts';
import TvNavigation from './components/common/TvNavigation';
import ConfirmDialog from './components/common/ConfirmDialog';
import MiniPlayer from './components/player/MiniPlayer';
import ProfileGate from './components/profiles/ProfileGate';
import PinPrompt from './components/profiles/PinPrompt';
import LaunchIntro from './components/layout/LaunchIntro';
import GamesUnavailable from './components/games/GamesUnavailable';
import { autoPurgeTrash } from './services/files';
import { basename } from './lib/path';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { engineStatus, initPlayerEvents, playBuiltin, syncAudioFilters, syncMiniLayout, syncSubtitleStyle } from './services/player';
import { fileToBase64TorrentSource, initTorrentService } from './services/torrents';
import { autoCheckForUpdates } from './services/updates';
import { startBackgroundAnalysis } from './services/enrich';
import { startFolderWatch } from './services/watch';
import { initMediaSession } from './services/mediasession';
import { initCastEvents } from './services/cast';
import { applyRemoteAccess, initRemoteApi } from './services/remoteapi';
import { CastBar, CastPicker } from './components/cast/CastUI';
import { reconnectOfflineShares, refreshShares } from './services/nas';

// Windows-only; other builds compile this to null and drop the Games code.
const GamesView = __GAMES__ ? lazy(() => import('./games/components/GamesView')) : null;

// Screens and dialogs that aren't on the first paint load in their own chunks.
const loaders = {
  discover: () => import('./components/browse/Discover'),
  live: () => import('./components/live/LiveTV'),
  settings: () => import('./components/settings/SettingsDialog'),
  detail: () => import('./components/modals/DetailModal'),
  fixMatch: () => import('./components/modals/FixMatchModal'),
  onboarding: () => import('./components/modals/OnboardingModal'),
  player: () => import('./components/player/PlayerScreen'),
  actor: () => import('./components/modals/ActorModal'),
  wrapped: () => import('./components/modals/WrappedModal'),
  history: () => import('./components/modals/HistoryModal'),
  rename: () => import('./components/modals/RenameModal'),
  health: () => import('./components/modals/HealthModal'),
  addTorrent: () => import('./components/torrents/AddTorrentModal'),
};
const Discover = lazy(loaders.discover);
const LiveTV = lazy(loaders.live);
const SettingsDialog = lazy(loaders.settings);
const DetailModal = lazy(loaders.detail);
const FixMatchModal = lazy(loaders.fixMatch);
const OnboardingModal = lazy(loaders.onboarding);
const PlayerScreen = lazy(loaders.player);
const ActorModal = lazy(loaders.actor);
const WrappedModal = lazy(loaders.wrapped);
const HistoryModal = lazy(loaders.history);
const RenameModal = lazy(loaders.rename);
const HealthModal = lazy(loaders.health);
const AddTorrentModal = lazy(loaders.addTorrent);

/** Warms every lazy chunk once the app is idle, so the first open never waits on the network/disk. */
function prefetchLazyChunks() {
  for (const load of Object.values(loaders)) void load().catch(() => {});
}

/** A top-level section: fades in/out and remembers its scroll position and view state. */
function SectionFrame({ section, children }: { section: string; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div variants={fade} initial="initial" animate="animate" exit="exit" className={present ? '' : 'pointer-events-none'}>
      <SectionMemory section={section} active={present}>{children}</SectionMemory>
    </motion.div>
  );
}

export default function App() {
  const ready = useLibraryStore((s) => s.ready);
  const init = useLibraryStore((s) => s.init);
  const view = useLibraryStore((s) => s.view);
  const search = useLibraryStore((s) => s.search);
  const detailKey = useLibraryStore((s) => s.detailKey);
  const fixMatchKey = useLibraryStore((s) => s.fixMatchKey);
  const settingsOpen = useLibraryStore((s) => s.settingsOpen);
  const onboardingOpen = useLibraryStore((s) => s.onboardingOpen);
  const addTorrentOpen = useLibraryStore((s) => !!s.addTorrentModal?.open);
  const [fatal, setFatal] = useState<string | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const launchIntro = useLibraryStore((s) => s.settings.launch_intro);
  const introSound = useLibraryStore((s) => s.settings.launch_intro_sound);

  useEffect(() => {
    init()
      .then(async () => {
        try {
          if (await invoke<boolean>('backup_restore_result')) {
            useLibraryStore.getState().toast('TruongFlix backup restored', 'success');
          }
        } catch (error) {
          useLibraryStore.getState().toast(`Backup restore failed: ${String(error)}`, 'error');
        }
      })
      .then(() => autoPurgeTrash().catch((e) => console.warn('[trash] auto-purge failed', e)))
      .then(async () => {
        void initTorrentService()
          .then(() => (__GAMES__ ? import('./games/jobs').then((m) => m.initGames()) : undefined))
          .catch((e) => console.warn('[torrents]', e));
        void applyRemoteAccess().catch((e) => console.warn('[remote]', e));
        // Bring back NAS folders that dropped off while the app was closed, then note any shares.
        await reconnectOfflineShares().catch(() => []);
        void refreshShares().then(() => startFolderWatch());
        // Fill in anything missing (media info, ratings, trailers, intros) without blocking startup.
        window.setTimeout(() => void startBackgroundAnalysis(), 3000);
      })
      .then(() => void autoCheckForUpdates())
      .then(async () => {
        // TRUONGFLIX_AUTOPLAY=<file> (CI smoke test): start playing right away.
        const path = await invoke<string | null>('startup_autoplay').catch(() => null);
        if (!path) return;
        const label = basename(path).replace(/\.[^.]+$/, '');
        setTimeout(() => void playBuiltin({ type: 'movie', id: -1, filePath: path, startTime: 0, label }), 1500);
      })
      .catch((e) => setFatal(String(e)));
    // Warm up the player engine so the first Play starts instantly.
    void engineStatus();
    initPlayerEvents().catch((e) => console.warn('Player events unavailable', e));
    initMediaSession().catch((e) => console.warn('Media keys unavailable', e));
    initCastEvents().catch((e) => console.warn('Casting unavailable', e));
    initRemoteApi().catch((e) => console.warn('Browser access unavailable', e));
  }, [init]);

  // Lock page scroll behind overlays (always on documentElement so body never becomes a nested scroller).
  const actorOpen = useLibraryStore((s) => !!s.actor);
  const profileGateOpen = useLibraryStore((s) => !!s.profileGate);
  const pageOverlay = useLibraryStore((s) => s.overlay);
  const overlay = !!detailKey || !!fixMatchKey || settingsOpen || onboardingOpen || addTorrentOpen || actorOpen || profileGateOpen || !!pageOverlay;
  useEffect(() => {
    document.documentElement.style.overflowY = overlay ? 'hidden' : '';
  }, [overlay]);

  // Built-in player: make the page transparent over the native video surface (not in the mini-player).
  const playerActive = useLibraryStore((s) => !!s.playerSession && !s.playerMini);
  useEffect(() => {
    document.documentElement.classList.toggle('player-mode', playerActive);
  }, [playerActive]);

  // Live-apply player settings and keep the mini-player glued to its corner.
  const subtitleStyle = useLibraryStore((s) => s.settings.subtitle_style);
  const audioNight = useLibraryStore((s) => s.settings.audio_night);
  const audioDialogue = useLibraryStore((s) => s.settings.audio_dialogue);
  useEffect(() => syncSubtitleStyle(), [subtitleStyle]);
  useEffect(() => syncAudioFilters(), [audioNight, audioDialogue]);
  useEffect(() => {
    window.addEventListener('resize', syncMiniLayout);
    return () => window.removeEventListener('resize', syncMiniLayout);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(prefetchLazyChunks, 1500);
    return () => window.clearTimeout(id);
  }, [ready]);

  // Restart folder watching when the folders or the setting change.
  const dirsKey = useLibraryStore((s) => `${s.settings.watch_folders}|${s.settings.tmdb_api_key ? 1 : 0}|${s.settings.media_directories.join('|')}`);
  useEffect(() => {
    if (ready) void refreshShares().then(() => startFolderWatch());
  }, [ready, dirsKey]);

  // Escape closes the top-most overlay; global drag-and-drop opens .torrent files & magnet links.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const s = useLibraryStore.getState();
      if (s.addTorrentModal?.open) s.closeAddTorrent();
      else if (s.fixMatchKey) s.openFixMatch(null);
      else if (s.actor) s.openActor(null);
      else if (s.detailEpisodeId != null) s.openEpisode(null);
      else if (s.detailKey) s.openDetail(null);
      else if (s.settingsOpen) s.setSettingsOpen(false);
      else if (s.overlay) s.setOverlay(null);
      else if (s.hover) s.setHover(null);
      else return;
      // Handled: TV mode's Back falls through to the navbar/Home only when nothing closed.
      e.preventDefault();
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('text/uri-list')) {
        e.preventDefault();
      }
    };
    const onDrop = async (e: DragEvent) => {
      const s = useLibraryStore.getState();
      if (!s.ready || s.addTorrentModal?.open) return;
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.name.toLowerCase().endsWith('.torrent'));
      if (file) {
        e.preventDefault();
        const b64 = await fileToBase64TorrentSource(file);
        useLibraryStore.getState().openAddTorrent(b64);
        return;
      }
      const text = (e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '').trim();
      if (text.toLowerCase().startsWith('magnet:')) {
        e.preventDefault();
        useLibraryStore.getState().openAddTorrent(text);
      }
    };
    let unlistenDrop: (() => void) | null = null;
    void listen<{ paths?: string[] }>('tauri://drag-drop', ({ payload }) => {
      const torrentPath = payload?.paths?.find((p) => p.toLowerCase().endsWith('.torrent'));
      const s = useLibraryStore.getState();
      if (torrentPath && s.ready) s.openAddTorrent(torrentPath);
    })
      .then((fn) => {
        unlistenDrop = fn;
      })
      .catch(() => {});

    window.addEventListener('keydown', onKey);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      unlistenDrop?.();
    };
  }, []);

  if (fatal) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-10 text-center">
        <Wordmark className="text-5xl" />
        <p className="max-w-lg text-nf-secondary">TruongFlix couldn’t open its library database.</p>
        <pre className="selectable max-w-2xl whitespace-pre-wrap rounded bg-black/40 p-4 text-left text-xs text-nf-muted">{fatal}</pre>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Wordmark className="animate-pulse text-6xl" />
      </div>
    );
  }

  const section = view === 'browse' || view === 'games' || view === 'live' ? view : search.trim() ? 'search' : view;

  return (
    <MotionConfig reducedMotion="user">
      <div id="app-root" className="relative min-h-screen bg-nf-bg">
        {/* Stays mounted (just hidden) during playback so scroll position and open pages survive. */}
        <div id="app-shell">
          <Navbar />
          <main>
            {/* One short fade between sections; each section restores where you left it. */}
            <AnimatePresence mode="wait" initial={false}>
              <SectionFrame key={section} section={section}>
                {view === 'browse' ? (
                  <Suspense fallback={null}><Discover /></Suspense>
                ) : view === 'games' ? (
                  GamesView ? <Suspense fallback={null}><GamesView /></Suspense> : <GamesUnavailable />
                ) : view === 'live' ? (
                  <Suspense fallback={null}><LiveTV /></Suspense>
                ) : search.trim() ? (
                  <SearchView query={search} />
                ) : view === 'mylist' ? (
                  <MyListView />
                ) : (
                  <BrowseView view={view} />
                )}
              </SectionFrame>
            </AnimatePresence>
          </main>

          <HoverPreview />
          {/* Each dialog gets its own boundary so loading one never blanks the others. */}
          <Suspense fallback={null}><AnimatePresence>{detailKey && <DetailModal key="detail" />}</AnimatePresence></Suspense>
          <Suspense fallback={null}><AnimatePresence>{fixMatchKey && <FixMatchModal key={fixMatchKey} />}</AnimatePresence></Suspense>
          <Suspense fallback={null}><AnimatePresence>{settingsOpen && <SettingsDialog key="settings" />}</AnimatePresence></Suspense>
          <Suspense fallback={null}><AnimatePresence>{addTorrentOpen && <AddTorrentModal key="add-torrent" />}</AnimatePresence></Suspense>
          <Suspense fallback={null}><AnimatePresence>{onboardingOpen && <OnboardingModal key="onboarding" />}</AnimatePresence></Suspense>
          <Suspense fallback={null}><ActorModal /></Suspense>
          <Suspense fallback={null}>
            <AnimatePresence>
              {pageOverlay === 'wrapped' && <WrappedModal key="wrapped" />}
              {pageOverlay === 'history' && <HistoryModal key="history" />}
              {pageOverlay === 'rename' && <RenameModal key="rename" />}
              {pageOverlay === 'health' && <HealthModal key="health" />}
            </AnimatePresence>
          </Suspense>
        </div>
        <MiniPlayer />
        <CastBar />
        <CastPicker />
        <Suspense fallback={null}><PlayerScreen /></Suspense>
        <ProfileGate />
        <PinPrompt />
        <Toasts />
        <ConfirmDialog />
        <TvNavigation />
        {launchIntro && !introDone && !onboardingOpen && <LaunchIntro sound={introSound} onDone={() => setIntroDone(true)} />}
      </div>
    </MotionConfig>
  );
}
