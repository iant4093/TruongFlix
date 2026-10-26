import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useLibraryStore } from './store/useLibraryStore';
import Navbar, { Wordmark } from './components/layout/Navbar';
import SidebarSettings from './components/layout/SidebarSettings';
import { BrowseView, MyListView, SearchView } from './components/home/Browse';
import HoverPreview from './components/home/HoverPreview';
import DetailModal from './components/modals/DetailModal';
import FixMatchModal from './components/modals/FixMatchModal';
import OnboardingModal from './components/modals/OnboardingModal';
import Toasts from './components/common/Toasts';
import ConfirmDialog from './components/common/ConfirmDialog';
import PlayerScreen from './components/player/PlayerScreen';
import MiniPlayer from './components/player/MiniPlayer';
import ProfileGate from './components/profiles/ProfileGate';
import LaunchIntro from './components/layout/LaunchIntro';
import ActorModal from './components/modals/ActorModal';
import WrappedModal from './components/modals/WrappedModal';
import HistoryModal from './components/modals/HistoryModal';
import RenameModal from './components/modals/RenameModal';
import { autoPurgeTrash } from './services/files';
import { invoke } from '@tauri-apps/api/core';
import { engineStatus, initPlayerEvents, playBuiltin, syncAudioFilters, syncMiniLayout, syncSubtitleStyle } from './services/player';
import { autoCheckForUpdates } from './services/updates';
import { startBackgroundAnalysis } from './services/enrich';
import { startFolderWatch } from './services/watch';

export default function App() {
  const ready = useLibraryStore((s) => s.ready);
  const init = useLibraryStore((s) => s.init);
  const view = useLibraryStore((s) => s.view);
  const search = useLibraryStore((s) => s.search);
  const detailKey = useLibraryStore((s) => s.detailKey);
  const fixMatchKey = useLibraryStore((s) => s.fixMatchKey);
  const settingsOpen = useLibraryStore((s) => s.settingsOpen);
  const onboardingOpen = useLibraryStore((s) => s.onboardingOpen);
  const [fatal, setFatal] = useState<string | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const launchIntro = useLibraryStore((s) => s.settings.launch_intro);
  const introSound = useLibraryStore((s) => s.settings.launch_intro_sound);

  useEffect(() => {
    init()
      .then(() => autoPurgeTrash().catch((e) => console.warn('[trash] auto-purge failed', e)))
      .then(() => {
        void startFolderWatch();
        // Fill in anything missing (media info, ratings, trailers, intros) without blocking startup.
        window.setTimeout(() => void startBackgroundAnalysis(), 3000);
      })
      .then(() => void autoCheckForUpdates())
      .then(async () => {
        // TRUONGFLIX_AUTOPLAY=<file> (CI smoke test): start playing right away.
        const path = await invoke<string | null>('startup_autoplay').catch(() => null);
        if (!path) return;
        const label = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '');
        setTimeout(() => void playBuiltin({ type: 'movie', id: -1, filePath: path, startTime: 0, label }), 1500);
      })
      .catch((e) => setFatal(String(e)));
    // Warm up the player engine so the first Play starts instantly.
    void engineStatus();
    initPlayerEvents().catch((e) => console.warn('Player events unavailable', e));
  }, [init]);

  // Lock page scroll behind overlays.
  const actorOpen = useLibraryStore((s) => !!s.actor);
  const pageOverlay = useLibraryStore((s) => s.overlay);
  const overlay = !!detailKey || !!fixMatchKey || settingsOpen || onboardingOpen || actorOpen || !!pageOverlay;
  useEffect(() => {
    document.body.style.overflow = overlay ? 'hidden' : '';
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

  // Restart folder watching when the folders or the setting change.
  const dirsKey = useLibraryStore((s) => `${s.settings.watch_folders}|${s.settings.tmdb_api_key ? 1 : 0}|${s.settings.media_directories.join('|')}`);
  useEffect(() => {
    if (ready) void startFolderWatch();
  }, [ready, dirsKey]);

  // Escape closes the top-most overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useLibraryStore.getState();
      if (s.fixMatchKey) s.openFixMatch(null);
      else if (s.actor) s.openActor(null);
      else if (s.detailEpisodeId != null) s.openEpisode(null);
      else if (s.detailKey) s.openDetail(null);
      else if (s.settingsOpen) s.setSettingsOpen(false);
      else if (s.overlay) s.setOverlay(null);
      else if (s.hover) s.setHover(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  return (
    <div id="app-root" className="relative min-h-screen bg-nf-bg">
      {/* Stays mounted (just hidden) during playback so scroll position and open pages survive. */}
      <div id="app-shell">
        <Navbar />
        <main>
          {search.trim() ? (
            <SearchView query={search} />
          ) : view === 'mylist' ? (
            <MyListView />
          ) : (
            <BrowseView key={view} view={view} />
          )}
        </main>

        <HoverPreview />
        <AnimatePresence>{detailKey && <DetailModal key="detail" />}</AnimatePresence>
        <AnimatePresence>{fixMatchKey && <FixMatchModal key={fixMatchKey} />}</AnimatePresence>
        <AnimatePresence>{settingsOpen && <SidebarSettings key="settings" />}</AnimatePresence>
        <AnimatePresence>{onboardingOpen && <OnboardingModal key="onboarding" />}</AnimatePresence>
        <ActorModal />
        <AnimatePresence>
          {pageOverlay === 'wrapped' && <WrappedModal key="wrapped" />}
          {pageOverlay === 'history' && <HistoryModal key="history" />}
          {pageOverlay === 'rename' && <RenameModal key="rename" />}
        </AnimatePresence>
      </div>
      <MiniPlayer />
      <PlayerScreen />
      <ProfileGate />
      <Toasts />
      <ConfirmDialog />
      {launchIntro && !introDone && !onboardingOpen && <LaunchIntro sound={introSound} onDone={() => setIntroDone(true)} />}
    </div>
  );
}
