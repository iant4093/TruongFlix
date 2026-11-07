import { useEffect, useRef, type ComponentType } from 'react';
import { motion } from 'framer-motion';
import { Captions, Home, Info, Library, Magnet, MonitorSmartphone, PlayCircle, Star, Trash2, Users, Volume2, type LucideIcon } from 'lucide-react';
import { useLibraryStore, type SettingsTab } from '../../store/useLibraryStore';
import Dialog from '../common/Dialog';
import Badge from '../common/Badge';
import LibraryPage from './LibraryPage';
import TorrentsPage from './TorrentsPage';
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
  { id: 'torrents', label: 'Torrents', icon: Magnet, page: TorrentsPage },
  { id: 'playback', label: 'Playback', icon: PlayCircle, page: PlaybackPage },
  { id: 'audio', label: 'Audio', icon: Volume2, page: AudioPage },
  { id: 'subtitles', label: 'Subtitles', icon: Captions, page: SubtitlesPage },
  { id: 'ratings', label: 'Ratings & data', icon: Star, page: RatingsPage },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone, page: DevicesPage },
  { id: 'home', label: 'Home', icon: Home, page: HomePage },
  { id: 'profiles', label: 'Profiles', icon: Users, page: ProfilesPage },
  { id: 'trash', label: 'Recently deleted', icon: Trash2, page: TrashPage },
  { id: 'about', label: 'About', icon: Info, page: AboutPage },
];

/** Settings window: categories on the left, one page at a time on the right. */
export default function SettingsDialog() {
  const tab = useLibraryStore((s) => s.settingsTab);
  const setOpen = useLibraryStore((s) => s.setSettingsOpen);
  const scanning = useLibraryStore((s) => s.scan.running);
  const activeTorrentCount = useLibraryStore(
    (s) => s.torrents.filter((t) => !t.finished && t.inSession && !t.paused && t.state !== 'error').length,
  );
  const scroller = useRef<HTMLDivElement>(null);
  const current = PAGES.find((p) => p.id === tab) ?? PAGES[0];
  const Current = current.page;

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <Dialog
      onClose={() => setOpen(false)}
      priority={66}
      size="window"
      chrome="floating"
      label="Settings"
      className="h-[min(800px,92vh)]"
      bodyClassName="flex min-h-0 flex-1"
    >
        <nav data-nav-tabs="" className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-black/25 p-3">
          <h1 className="px-3 pb-4 pt-2 text-xl font-bold">Settings</h1>
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={id === current.id ? 'page' : undefined}
              data-nav-autofocus={id === current.id ? '' : undefined}
              onClick={() => setOpen(true, id)}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                id === current.id ? 'bg-white/10 font-semibold text-white' : 'text-nf-secondary hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {id === 'library' && scanning && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-nf-red" title="Scanning" />}
              {id === 'torrents' && activeTorrentCount > 0 && (
                <Badge tone="download" pill title="Active downloads">
                  {activeTorrentCount}
                </Badge>
              )}
            </button>
          ))}
        </nav>

        <div className="relative flex min-w-0 flex-1 flex-col">
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
    </Dialog>
  );
}
