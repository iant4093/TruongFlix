import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BarChart3, ChevronDown, History, RefreshCw, Search, Settings, Square, Users, X } from 'lucide-react';
import ProfileAvatar from '../common/ProfileAvatar';
import { useLibraryStore, type View } from '../../store/useLibraryStore';
import { runScan } from '../../services/scanner';
import { stopPlayback } from '../../services/player';
import { formatTimestamp } from '../../store/selectors';

const LINKS: { view: View; label: string }[] = [
  { view: 'home', label: 'Home' },
  { view: 'tv', label: 'TV Shows' },
  { view: 'movies', label: 'Movies' },
  { view: 'mylist', label: 'My List' },
];

const WORDMARK = 'TRUONGFLIX';

/**
 * Netflix-style wordmark: condensed caps whose letters grow taller toward both ends,
 * giving the logo its signature curved "banner" silhouette.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  const mid = (WORDMARK.length - 1) / 2;
  return (
    <span className={`nf-wordmark ${className}`} aria-label="TruongFlix">
      {[...WORDMARK].map((ch, i) => {
        const d = Math.abs(i - mid) / mid;
        return (
          <span key={i} aria-hidden style={{ transform: `scaleY(${(1.12 + 0.2 * d * d).toFixed(3)})` }}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

export default function Navbar() {
  const view = useLibraryStore((s) => s.view);
  const setView = useLibraryStore((s) => s.setView);
  const search = useLibraryStore((s) => s.search);
  const setSearch = useLibraryStore((s) => s.setSearch);
  const scanning = useLibraryStore((s) => s.scan.running);
  const playback = useLibraryStore((s) => s.playback);
  const openSettings = useLibraryStore((s) => s.setSettingsOpen);

  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (search && !searchOpen) setSearchOpen(true);
  }, [search, searchOpen]);

  const closeSearch = () => {
    setSearch('');
    setSearchOpen(false);
  };

  return (
    <header
      className="fixed inset-x-0 top-0 z-50 flex h-[68px] items-center px-[4%] transition-colors duration-300 ease-in-out"
      style={{
        background: scrolled ? '#141414' : 'linear-gradient(180deg, rgba(0,0,0,0.7) 10%, transparent)',
      }}
    >
      <button onClick={() => setView('home')} className="mr-10 shrink-0" aria-label="TruongFlix home">
        <Wordmark className="text-[1.9rem]" />
      </button>

      <nav className="flex items-center gap-5 text-sm">
        {LINKS.map((l) => (
          <button
            key={l.view}
            onClick={() => setView(l.view)}
            className={`whitespace-nowrap transition-colors duration-300 ${
              view === l.view && !search ? 'font-semibold text-white' : 'text-[#e5e5e5] hover:text-[#b3b3b3]'
            }`}
          >
            {l.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-5 text-white">
        {playback.active && (
          <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/50 py-1 pl-3 pr-1 text-xs">
            <span className="h-2 w-2 animate-pulse rounded-full bg-nf-red" />
            <span className="text-nf-secondary">Playing in VLC</span>
            {playback.length > 0 && (
              <span className="tabular-nums text-white/80">
                {formatTimestamp(playback.time)} / {formatTimestamp(playback.length)}
              </span>
            )}
            <button
              onClick={() => stopPlayback()}
              title="Stop playback"
              className="ml-1 rounded-full p-1 text-white/70 hover:bg-white/10 hover:text-white"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          </div>
        )}

        <div
          className={`flex items-center transition-all duration-300 ${
            searchOpen ? 'border border-white bg-black/75' : 'border border-transparent'
          }`}
        >
          <button
            onClick={() => (searchOpen ? inputRef.current?.focus() : setSearchOpen(true))}
            className="p-1.5"
            aria-label="Search"
          >
            <Search className="h-5 w-5" />
          </button>
          <AnimatePresence initial={false}>
            {searchOpen && (
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 260, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                className="flex items-center overflow-hidden"
              >
                <input
                  ref={inputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onBlur={() => !search && setSearchOpen(false)}
                  onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
                  placeholder="Titles, people, genres"
                  className="w-full bg-transparent py-1 pr-2 text-sm text-white placeholder:text-[#8c8c8c] outline-none"
                />
                {search && (
                  <button onMouseDown={(e) => e.preventDefault()} onClick={closeSearch} className="pr-2">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          onClick={() => runScan()}
          disabled={scanning}
          title={scanning ? 'Scanning…' : 'Scan Library'}
          className="flex items-center gap-1.5 text-sm text-[#e5e5e5] transition-colors hover:text-white disabled:cursor-wait"
        >
          <RefreshCw className={`h-5 w-5 ${scanning ? 'animate-spin text-nf-red' : ''}`} />
          <span className="hidden xl:inline">{scanning ? 'Scanning…' : 'Scan Library'}</span>
        </button>

        <button
          onClick={() => openSettings(true)}
          title="Settings"
          aria-label="Settings"
          className="text-[#e5e5e5] transition-colors hover:text-white"
        >
          <Settings className="h-5 w-5" />
        </button>
        <ProfileMenu />
      </div>
    </header>
  );
}

/** Avatar with a Netflix-style dropdown: switch profile, manage profiles, activity and Wrapped. */
function ProfileMenu() {
  const profiles = useLibraryStore((s) => s.profiles);
  const active = useLibraryStore((s) => s.activeProfile);
  const switchProfile = useLibraryStore((s) => s.switchProfile);
  const setGate = useLibraryStore((s) => s.setProfileGate);
  const setOverlay = useLibraryStore((s) => s.setOverlay);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  if (!active) return null;

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    timer.current = window.setTimeout(() => setOpen(false), 200);
  };
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5" title={active.name}>
        <ProfileAvatar color={active.color} maturity={active.maturity} size={32} />
        <ChevronDown className={`h-4 w-4 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full mt-4 w-56 border border-white/15 bg-black/90 py-2 text-sm shadow-2xl backdrop-blur"
          >
            {profiles
              .filter((p) => p.id !== active.id)
              .map((p) => (
                <button key={p.id} onClick={pick(() => void switchProfile(p.id))} className="flex w-full items-center gap-3 px-4 py-2 hover:underline">
                  <ProfileAvatar color={p.color} maturity={p.maturity} size={28} />
                  {p.name}
                </button>
              ))}
            <button onClick={pick(() => setGate('manage'))} className="flex w-full items-center gap-3 px-4 py-2 hover:underline">
              <Users className="h-5 w-5 text-nf-secondary" /> Manage Profiles
            </button>
            <div className="my-2 border-t border-white/15" />
            <button onClick={pick(() => setOverlay('history'))} className="flex w-full items-center gap-3 px-4 py-2 hover:underline">
              <History className="h-5 w-5 text-nf-secondary" /> Viewing Activity
            </button>
            <button onClick={pick(() => setOverlay('wrapped'))} className="flex w-full items-center gap-3 px-4 py-2 hover:underline">
              <BarChart3 className="h-5 w-5 text-nf-secondary" /> Your TruongFlix Wrapped
            </button>
            {profiles.length > 1 && (
              <>
                <div className="my-2 border-t border-white/15" />
                <button onClick={pick(() => setGate('select'))} className="w-full px-4 py-2 text-center hover:underline">
                  Switch profile
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
