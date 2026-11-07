import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BarChart3, ChevronDown, History, Magnet, RefreshCw, Search, Settings, Square, Users, X } from 'lucide-react';
import ProfileAvatar from '../common/ProfileAvatar';
import { guardAdult, switchProfileGuarded } from '../../services/profilelock';
import { formatLeft, limitStatus } from '../../services/limits';
import { useLibraryStore, type View } from '../../store/useLibraryStore';
import { runScan } from '../../services/scanner';
import { stopPlayback } from '../../services/player';
import { formatSpeed, isActiveDownload } from '../../services/torrents';
import { formatTimestamp } from '../../store/selectors';

const LINKS: { view: View; label: string }[] = [
  { view: 'home', label: 'Home' },
  { view: 'tv', label: 'TV Shows' },
  { view: 'movies', label: 'Movies' },
  { view: 'live', label: 'Live TV' },
  { view: 'browse', label: 'Browse' },
  { view: 'games', label: 'Games' },
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
  const searchButtonRef = useRef<HTMLButtonElement>(null);

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
    searchButtonRef.current?.focus();
  };

  return (
    <header
      className="fixed inset-x-0 top-0 z-50 flex h-[68px] items-center px-[4%] transition-colors duration-300 ease-in-out"
      style={{
        background: scrolled ? '#141414' : 'linear-gradient(180deg, rgba(0,0,0,0.7) 10%, transparent)',
      }}
    >
      <button onClick={() => setView('home')} className="mr-6 shrink-0 xl:mr-10" aria-label="TruongFlix home">
        <Wordmark className="text-[1.9rem]" />
      </button>

      <nav aria-label="Main navigation" className="flex items-center gap-3 text-sm xl:gap-5">
        {LINKS.map((l) => (
          <button
            key={l.view}
            aria-current={view === l.view && !search ? 'page' : undefined}
            onClick={() => setView(l.view)}
            className={`whitespace-nowrap transition-colors duration-300 ${
              view === l.view && !search ? 'font-semibold text-white' : 'text-[#e5e5e5] hover:text-[#b3b3b3]'
            }`}
          >
            {l.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-white xl:gap-5">
        {playback.active && (
          <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/50 py-1 pl-3 pr-1 text-xs">
            <span className="h-2 w-2 animate-pulse rounded-full bg-nf-red" />
            <span className="hidden text-nf-secondary xl:inline">Playing in VLC</span>
            {playback.length > 0 && (
              <span className="hidden tabular-nums text-white/80 xl:inline">
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

        {view === 'browse' ? (
          <button aria-label="Search Browse" className="p-1.5" onClick={() => document.querySelector<HTMLInputElement>('input[aria-label="Search titles to browse"]')?.focus()}><Search className="h-5 w-5" /></button>
        ) : view === 'games' ? (
          <button aria-label="Search games" className="p-1.5" onClick={() => document.querySelector<HTMLInputElement>('input[aria-label="Search games"]')?.focus()}><Search className="h-5 w-5" /></button>
        ) : view === 'live' ? (
          <button
            aria-label="Search live TV"
            className="p-1.5"
            onClick={() => document.querySelector<HTMLInputElement>('input[aria-label="Search live TV"]')?.focus()}
          >
            <Search className="h-5 w-5" />
          </button>
        ) : <div className="relative">
          <button
            ref={searchButtonRef}
            type="button"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            className={`rounded p-1.5 ${searchOpen ? 'bg-white/15' : ''}`}
            aria-label="Search"
            aria-expanded={searchOpen}
            aria-controls={searchOpen ? 'library-search' : undefined}
          >
            <Search className="h-5 w-5" />
          </button>
          <AnimatePresence initial={false}>
            {searchOpen && (
              <motion.div
                id="library-search"
                initial={{ y: -4, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -4, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute right-0 top-full mt-2 flex w-[min(290px,85vw)] items-center rounded border border-white/25 bg-nf-surface px-3 shadow-xl"
              >
                <input
                  ref={inputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search your library"
                  onBlur={(e) => { if (!search && e.relatedTarget !== searchButtonRef.current) setSearchOpen(false); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); } }}
                  placeholder="Titles, people, genres"
                  className="min-w-0 flex-1 bg-transparent py-2.5 pr-2 text-sm text-white placeholder:text-nf-muted outline-none"
                />
                {search && (
                  <button type="button" aria-label="Clear search" onClick={closeSearch} className="p-1">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>}

        <button
          onClick={() => runScan()}
          disabled={scanning}
          title={scanning ? 'Scanning…' : 'Scan Library'}
          className="flex items-center gap-1.5 text-sm text-[#e5e5e5] transition-colors hover:text-white disabled:cursor-wait"
        >
          <RefreshCw className={`h-5 w-5 ${scanning ? 'animate-spin text-nf-red' : ''}`} />
          <span className="hidden xl:inline">{scanning ? 'Scanning…' : 'Scan Library'}</span>
        </button>

        <TorrentMenu />

        <button
          onClick={(event) => {
            event.currentTarget.focus();
            openSettings(true);
          }}
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

/** Add a torrent or jump straight to the transfer list while downloading. */
function TorrentMenu() {
  const torrents = useLibraryStore((s) => s.torrents);
  const openAddTorrent = useLibraryStore((s) => s.openAddTorrent);
  const openSettings = useLibraryStore((s) => s.setSettingsOpen);
  const activeDownloads = torrents.filter(isActiveDownload);
  const totalSpeed = activeDownloads.reduce((sum, t) => sum + (t.downloadSpeedBps || 0), 0);
  const downloading = activeDownloads.length > 0;

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-sm text-[#e5e5e5]">
      <button
        type="button"
        onClick={() => openAddTorrent()}
        title="Add Magnet or .torrent"
        aria-label="Add Magnet or .torrent"
        className="flex items-center gap-1.5 transition-colors hover:text-white"
      >
        <Magnet className={`h-5 w-5 ${downloading ? 'text-sky-400' : ''}`} />
        {!downloading && <span className="hidden xl:inline">Torrents</span>}
      </button>
      {downloading && (
        <button
          type="button"
          onClick={() => openSettings(true, 'torrents')}
          title="View torrent transfers"
          aria-label="View torrent transfers"
          className="flex items-center gap-1.5 tabular-nums transition-colors hover:text-white"
        >
          <span className="rounded-full bg-sky-500/20 px-1.5 py-[1px] text-[10px] font-bold text-sky-300">
            {activeDownloads.length}
          </span>
          <span className="hidden xl:inline">
            {totalSpeed > 0 ? `↓ ${formatSpeed(totalSpeed)}` : 'Transfers'}
          </span>
        </button>
      )}
    </div>
  );
}

/** Avatar with a Netflix-style dropdown: switch profile, manage profiles, activity and Wrapped. */
function ProfileMenu() {
  const profiles = useLibraryStore((s) => s.profiles);
  const active = useLibraryStore((s) => s.activeProfile);
  const setGate = useLibraryStore((s) => s.setProfileGate);
  const setOverlay = useLibraryStore((s) => s.setOverlay);
  const [open, setOpen] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !active || (!active.daily_limit && !active.bedtime)) return setTimeLeft(null);
    void limitStatus(active).then((st) =>
      setTimeLeft(
        st.blocked === 'bedtime'
          ? `Bedtime until ${active.wake_time || '07:00'}`
          : st.blocked === 'limit'
            ? 'No TV time left today'
            : st.remaining != null
              ? `${formatLeft(st.remaining)} of TV left today`
              : active.bedtime
                ? `Bedtime at ${active.bedtime}`
                : null,
      ),
    );
  }, [open, active]);
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
            {timeLeft && <div className="border-b border-white/15 px-4 pb-2 text-xs text-nf-secondary">{timeLeft}</div>}
            {profiles
              .filter((p) => p.id !== active.id)
              .map((p) => (
                <button key={p.id} onClick={pick(() => switchProfileGuarded(p.id))} className="flex w-full items-center gap-3 px-4 py-2 hover:underline">
                  <ProfileAvatar color={p.color} maturity={p.maturity} size={28} />
                  {p.name}
                </button>
              ))}
            <button onClick={pick(() => guardAdult(() => setGate('manage')))} className="flex w-full items-center gap-3 px-4 py-2 hover:underline">
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
