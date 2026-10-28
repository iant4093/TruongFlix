import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useLibraryStore } from './store/useLibraryStore';
import Navbar, { Wordmark } from './components/layout/Navbar';
import SettingsDialog from './components/settings/SettingsDialog';
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
import PinPrompt from './components/profiles/PinPrompt';
import LaunchIntro from './components/layout/LaunchIntro';
import ActorModal from './components/modals/ActorModal';
import WrappedModal from './components/modals/WrappedModal';
import HistoryModal from './components/modals/HistoryModal';
import RenameModal from './components/modals/RenameModal';
import HealthModal from './components/modals/HealthModal';
import AddTorrentModal from './components/torrents/AddTorrentModal';
import { autoPurgeTrash } from './services/files';
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
      .then(() => autoPurgeTrash().catch((e) => console.warn('[trash] auto-purge failed', e)))
      .then(async () => {
        void initTorrentService().catch((e) => console.warn('[torrents]', e));
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
        const label = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '');
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

  // Restart folder watching when the folders or the setting change.
  const dirsKey = useLibraryStore((s) => `${s.settings.watch_folders}|${s.settings.tmdb_api_key ? 1 : 0}|${s.settings.media_directories.join('|')}`);
  useEffect(() => {
    if (ready) void refreshShares().then(() => startFolderWatch());
  }, [ready, dirsKey]);

  // Escape closes the top-most overlay; global drag-and-drop opens .torrent files & magnet links.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useLibraryStore.getState();
      if (s.addTorrentModal?.open) s.closeAddTorrent();
      else if (s.fixMatchKey) s.openFixMatch(null);
      else if (s.actor) s.openActor(null);
      else if (s.detailEpisodeId != null) s.openEpisode(null);
      else if (s.detailKey) s.openDetail(null);
      else if (s.settingsOpen) s.setSettingsOpen(false);
      else if (s.overlay) s.setOverlay(null);
      else if (s.hover) s.setHover(null);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('text/uri-list')) {
        e.preventDefault();
      }
    };
    const onDrop = async (e: DragEvent) => {
      if (useLibraryStore.getState().addTorrentModal?.open) return;
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
      if (torrentPath) useLibraryStore.getState().openAddTorrent(torrentPath);
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
        <AnimatePresence>{settingsOpen && <SettingsDialog key="settings" />}</AnimatePresence>
        <AnimatePresence>{addTorrentOpen && <AddTorrentModal key="add-torrent" />}</AnimatePresence>
        <AnimatePresence>{onboardingOpen && <OnboardingModal key="onboarding" />}</AnimatePresence>
        <ActorModal />
        <AnimatePresence>
          {pageOverlay === 'wrapped' && <WrappedModal key="wrapped" />}
          {pageOverlay === 'history' && <HistoryModal key="history" />}
          {pageOverlay === 'rename' && <RenameModal key="rename" />}
          {pageOverlay === 'health' && <HealthModal key="health" />}
        </AnimatePresence>
      </div>
      <MiniPlayer />
      <CastBar />
      <CastPicker />
      <PlayerScreen />
      <ProfileGate />
      <PinPrompt />
      <Toasts />
      <ConfirmDialog />
      {launchIntro && !introDone && !onboardingOpen && <LaunchIntro sound={introSound} onDone={() => setIntroDone(true)} />}
    </div>
  );
}
