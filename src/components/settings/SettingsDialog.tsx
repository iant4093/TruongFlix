import { useEffect, useRef, type ComponentType } from 'react';
import { motion } from 'framer-motion';
import { Captions, Home, Info, Library, MonitorSmartphone, PlayCircle, Star, Trash2, Users, Volume2, X, type LucideIcon } from 'lucide-react';
import { useLibraryStore, type SettingsTab } from '../../store/useLibraryStore';
import LibraryPage from './LibraryPage';
import PlaybackPage from './PlaybackPage';
import AudioPage from './AudioPage';
import SubtitlesPage from './SubtitlesPage';
import RatingsPage from './RatingsPage';
import DevicesPage from './DevicesPage';
import HomePage from './HomePage';
import ProfilesPage from './ProfilesPage';
import TrashPage from './TrashPage';
import AboutPage from './AboutPage';

const PAGES: { id: SettingsTab; label: string; icon: LucideIcon; page: ComponentType }[] = [
  { id: 'library', label: 'Library', icon: Library, page: LibraryPage },
  { id: 'playback', label: 'Playback', icon: PlayCircle, page: PlaybackPage },
  { id: 'audio', label: 'Audio', icon: Volume2, page: AudioPage },
  { id: 'subtitles', label: 'Subtitles', icon: Captions, page: SubtitlesPage },
  { id: 'ratings', label: 'Ratings & Data', icon: Star, page: RatingsPage },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone, page: DevicesPage },
  { id: 'home', label: 'Home', icon: Home, page: HomePage },
  { id: 'profiles', label: 'Profiles', icon: Users, page: ProfilesPage },
  { id: 'trash', label: 'Recently Deleted', icon: Trash2, page: TrashPage },
  { id: 'about', label: 'About', icon: Info, page: AboutPage },
];

/** Settings window: categories on the left, one page at a time on the right. */
export default function SettingsDialog() {
  const tab = useLibraryStore((s) => s.settingsTab);
  const setOpen = useLibraryStore((s) => s.setSettingsOpen);
  const scanning = useLibraryStore((s) => s.scan.running);
  const scroller = useRef<HTMLDivElement>(null);
  const current = PAGES.find((p) => p.id === tab) ?? PAGES[0];
  const Current = current.page;

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
      className="fixed inset-0 z-[66] flex items-center justify-center bg-black/70 p-6 backdrop-blur-xs"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 12 }}
        transition={{ duration: 0.22, ease: [0.21, 0, 0.27, 1] }}
        role="dialog"
        aria-label="Settings"
        className="flex h-[min(800px,92vh)] w-[min(1060px,96vw)] overflow-hidden rounded-xl bg-nf-surface shadow-2xl ring-1 ring-white/10"
      >
        <nav className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-black/25 p-3">
          <h1 className="px-3 pb-4 pt-2 text-xl font-bold">Settings</h1>
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setOpen(true, id)}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                id === current.id ? 'bg-white/10 font-semibold text-white' : 'text-nf-secondary hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {id === 'library' && scanning && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-nf-red" title="Scanning" />}
            </button>
          ))}
        </nav>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            onClick={() => setOpen(false)}
            aria-label="Close settings"
            className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
          <div ref={scroller} className="flex-1 overflow-y-auto">
            <motion.div
              key={current.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className="settings-compact max-w-3xl px-10 pb-12 pt-8"
            >
              <Current />
            </motion.div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
