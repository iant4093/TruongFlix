import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { restoreScroll, saveScroll } from './scrollMemory';
import { leavingClass, useLeaving } from '../lib/leaving';
import { Download, Lock, Search, X } from 'lucide-react';
import SlidingPill from '../components/common/SlidingPill';
import ProfileAvatar from '../components/common/ProfileAvatar';
import type { RemoteItem, RemoteLibrary, RemotePlayable, RemoteProfile, RemoteTitle } from './types';
import { Featured, Poster, Row } from './RemoteBits';
import TitlePage from './RemoteTitle';
import { api, AuthError, getToken, login, qs } from './api';
import RemotePlayer from './RemotePlayer';
import { NowPlayingBar, RemoteSheet, useNowPlaying } from './RemoteControl';
import { errorMessage } from '../lib/errors';
import RemoteLiveSection from './RemoteLive';
import { RemoteMusicPlayer, RemoteMusicSection, useRemoteMusic } from './RemoteMusic';
import { pause as pauseMusic } from '../music/player';
import type { RemoteRow } from './types';
import { DownloadsPage } from './RemoteDownloads';
import { initOffline } from './offline';
import type { OfflineItem } from './offlineLogic';

type Tab = 'home' | 'tv' | 'movies' | 'live' | 'music' | 'mylist';
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'home', label: 'Home' },
  { tab: 'tv', label: 'TV Shows' },
  { tab: 'movies', label: 'Movies' },
  { tab: 'live', label: 'Live TV' },
  { tab: 'music', label: 'Music' },
  { tab: 'mylist', label: 'My List' },
];

/** Rows for the TV Shows or Movies section, built from the library the PC sent. */
function sectionRows(lib: RemoteLibrary, kind: 'movie' | 'tv'): RemoteRow[] {
  const pick = (row?: RemoteRow) => row?.items.filter((i) => i.kind === kind) ?? [];
  const all = lib.all.filter((i) => i.kind === kind);
  const rows: RemoteRow[] = [
    { title: 'Continue Watching', items: pick(lib.rows.find((r) => r.title === 'Continue Watching')) },
    { title: 'Recently Added', items: pick(lib.rows.find((r) => r.title === 'Recently Added')) },
  ];
  const genres = new Map<string, RemoteItem[]>();
  for (const i of all) for (const g of i.genres.slice(0, 2)) genres.set(g, [...(genres.get(g) ?? []), i]);
  for (const [g, items] of [...genres.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) rows.push({ title: g, items });
  rows.push({ title: kind === 'tv' ? 'All TV Shows' : 'All Movies', items: [...all].sort((a, b) => a.title.localeCompare(b.title)) });
  return rows.filter((r) => r.items.length);
}

type Who = { id: number; key?: string; profile: RemoteProfile };
type Screen =
  | { name: 'home' }
  | { name: 'title'; key: string }
  | { name: 'downloads' }
  | { name: 'play'; target: RemotePlayable; offline?: OfflineItem; from?: Screen };

/** The last screen shown, so coming back from a title or Downloads slides in like Back (not a fade). */
let lastScreen: Screen['name'] = 'home';

/** A section's content: slides in from the left when you came back to it, else fades in (decided once, as it appears). */
function Entrance({ back, children }: { back: boolean; children: React.ReactNode }) {
  const [className] = useState(back ? 'nf-pop' : 'nf-fade');
  return <div className={className}>{children}</div>;
}

function Wordmark({ className = '' }: { className?: string }) {
  return <span className={`nf-wordmark ${className}`}>TRUONGFLIX</span>;
}

/** The library in a phone/tablet/computer browser on the home network. */
export default function RemoteApp() {
  const [signedIn, setSignedIn] = useState(!!getToken());
  const [who, setWho] = useState<Who | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('tf-remote-who') ?? 'null');
    } catch {
      return null;
    }
  });
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const cameBack = screen.name === 'home' && (lastScreen === 'title' || lastScreen === 'downloads');
  useEffect(() => {
    lastScreen = screen.name;
  }, [screen.name]);
  // A video takes over from the music.
  useEffect(() => {
    if (screen.name === 'play') pauseMusic();
  }, [screen.name]);

  const choose = (w: Who | null) => {
    setWho(w);
    if (w) sessionStorage.setItem('tf-remote-who', JSON.stringify(w));
    else sessionStorage.removeItem('tf-remote-who');
    setScreen({ name: 'home' });
  };
  const onAuthError = useCallback((e: unknown) => {
    if (e instanceof AuthError) setSignedIn(false);
  }, []);
  useEffect(() => {
    void initOffline();
  }, []);

  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;
  if (!who) return <Profiles onPick={choose} onAuthError={onAuthError} />;
  if (screen.name === 'play')
    return (
      <RemotePlayer
        key={screen.offline ? `offline-${screen.offline.id}` : 'stream'}
        who={who}
        target={screen.target}
        offline={screen.offline}
        onExit={() => setScreen(screen.from ?? { name: 'home' })}
        onPlay={(t) => setScreen({ name: 'play', target: t })}
      />
    );
  if (screen.name === 'downloads')
    return (
      <DownloadsPage
        who={who}
        back={() => setScreen({ name: 'home' })}
        play={(item) =>
          setScreen({
            name: 'play',
            target: { type: item.type, id: item.mediaId, label: item.subtitle ?? item.title, resume: item.position },
            offline: item,
            from: { name: 'downloads' },
          })
        }
      />
    );
  return (
    <Browse
      who={who}
      screen={screen}
      cameBack={cameBack}
      open={(key) => setScreen({ name: 'title', key })}
      play={(target) => setScreen({ name: 'play', target })}
      back={() => setScreen({ name: 'home' })}
      switchProfile={() => choose(null)}
      openDownloads={() => setScreen({ name: 'downloads' })}
      onAuthError={onAuthError}
    />
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await login(code.trim());
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nf-fade flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
      <Wordmark className="text-5xl" />
      <p className="mt-6 max-w-sm text-nf-secondary">Enter the access code shown in TruongFlix on your computer, under Settings › Devices.</p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && submit()}
        inputMode="numeric"
        autoFocus
        placeholder="••••••"
        className="mt-6 w-56 rounded border border-white/30 bg-black/50 px-4 py-3 text-center text-3xl tracking-[0.4em] outline-none focus:border-white"
      />
      {error && <p className="mt-3 text-sm text-nf-red">{error}</p>}
      <button onClick={() => void submit()} disabled={code.length !== 6 || busy} className="nf-btn-red mt-6 w-56 py-3 text-lg disabled:opacity-50">
        Continue
      </button>
    </div>
  );
}

function Profiles({ onPick, onAuthError }: { onPick: (w: Who) => void; onAuthError: (e: unknown) => void }) {
  const [profiles, setProfiles] = useState<RemoteProfile[] | null>(null);
  const [locked, setLocked] = useState<RemoteProfile | null>(null);
  const pinFor = useLeaving(locked, 240);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<RemoteProfile[]>('/profiles').then(setProfiles).catch(onAuthError);
  }, [onAuthError]);
  const unlock = async (p: RemoteProfile, value: string) => {
    try {
      const { key } = await api<{ key: string }>('/unlock', { body: { profile: p.id, pin: value } });
      onPick({ id: p.id, key, profile: p });
    } catch (e) {
      setError(errorMessage(e));
      setPin('');
    }
  };
  return (
    <div className="nf-fade flex min-h-[100dvh] flex-col items-center justify-center px-6">
      <h1 className="mb-10 text-3xl font-medium sm:text-5xl">Who’s watching?</h1>
      <div className="flex flex-wrap justify-center gap-6">
        {profiles?.map((p) => (
          <button key={p.id} onClick={() => (p.locked ? (setLocked(p), setError(''), setPin('')) : onPick({ id: p.id, profile: p }))} className="group flex w-24 flex-col items-center gap-2 sm:w-32">
            <ProfileAvatar color={p.color} maturity={p.maturity} size={128} className="!h-24 !w-24 ring-white group-hover:ring-2 sm:!h-32 sm:!w-32" />
            <span className="flex items-center gap-1 text-nf-secondary group-hover:text-white">
              {p.name}
              {p.locked && <Lock className="h-3.5 w-3.5" />}
            </span>
          </button>
        ))}
      </div>
      {pinFor.shown && (
        <div className={`nf-fade fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-6 ${leavingClass(pinFor.closing)}`} onClick={() => setLocked(null)}>
          <div className="nf-pop-in w-full max-w-xs text-center" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-medium">Enter {pinFor.shown.name}’s PIN</h2>
            <input
              value={pin}
              autoFocus
              inputMode="numeric"
              type="password"
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                setPin(v);
                if (v.length === 4 && locked) void unlock(locked, v);
              }}
              className="mt-6 w-40 rounded border border-white/30 bg-black/50 px-4 py-3 text-center text-3xl tracking-[0.5em] outline-none focus:border-white"
            />
            {error && <p className="mt-3 text-sm text-nf-red">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Browse({
  who,
  screen,
  cameBack,
  open: openTitle,
  play: playTitle,
  back,
  switchProfile,
  openDownloads: showDownloads,
  onAuthError,
}: {
  who: Who;
  screen: Screen;
  cameBack: boolean;
  open: (key: string) => void;
  play: (t: RemotePlayable) => void;
  back: () => void;
  switchProfile: () => void;
  openDownloads: () => void;
  onAuthError: (e: unknown) => void;
}) {
  const [lib, setLib] = useState<RemoteLibrary | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  // Picks each section's billboard once per visit.
  const [featuredSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const [tab, setTabState] = useState<Tab>(() => (sessionStorage.getItem('tf-remote-tab') as Tab | null) ?? 'home');
  // Each section remembers where you were: in it, and when you come back from a title, the
  // player or Downloads.
  const page = `tab:${tab}`;
  const setTab = (next: Tab) => {
    saveScroll(page);
    setTabState(next);
    sessionStorage.setItem('tf-remote-tab', next);
    setQuery(null);
  };
  useLayoutEffect(() => {
    if (screen.name === 'home') restoreScroll(page);
  }, [screen.name, page]);
  const open = (key: string) => {
    if (screen.name === 'home') saveScroll(page);
    openTitle(key);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const play = (target: RemotePlayable) => {
    if (screen.name === 'home') saveScroll(page);
    playTitle(target);
  };
  const openDownloads = () => {
    if (screen.name === 'home') saveScroll(page);
    showDownloads();
  };
  const playKey = async (key: string) => {
    try {
      const t = await api<RemoteTitle>(`/title${qs({ profile: who.id, key: who.key, item: key })}`);
      if (t.play) play(t.play);
      else open(key);
    } catch (e) {
      onAuthError(e);
      open(key);
    }
  };
  // The header turns solid once the page scrolls, like the desktop navbar.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const now = useNowPlaying(who, true, onAuthError);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const closeRemote = useCallback(() => setRemoteOpen(false), []);
  const remoteSheet = useLeaving(remoteOpen);
  const musicPlaying = useRemoteMusic(who);
  const remote = (
    <>
      {!remoteOpen && <NowPlayingBar now={now} onOpen={() => setRemoteOpen(true)} />}
      {remoteSheet.shown && <RemoteSheet now={now} onClose={closeRemote} closing={remoteSheet.closing} />}
      <RemoteMusicPlayer lifted={!!now.np && !remoteOpen} />
    </>
  );
  const pad = now.np && musicPlaying ? 'pb-48' : now.np || musicPlaying ? 'pb-28' : 'pb-16';
  useEffect(() => {
    api<RemoteLibrary>(`/library${qs({ profile: who.id, key: who.key })}`)
      .then(setLib)
      .catch((e) => {
        onAuthError(e);
        setError(errorMessage(e));
      });
  }, [who, screen.name, onAuthError]);

  // Every word must match the title, year or a genre; accents and case don't matter ("amelie 2001").
  const results = useMemo(() => {
    const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const words = fold(query ?? '').split(/\s+/).filter(Boolean);
    if (!words.length || !lib) return [];
    return lib.all.filter((i) => {
      const hay = fold(`${i.title} ${i.year ?? ''} ${(i.genres ?? []).join(' ')}`);
      return words.every((w) => hay.includes(w));
    });
  }, [query, lib]);

  // Keep the current section's tab in view on phones, where the tabs scroll sideways.
  const tabsRef = useRef<HTMLElement>(null);
  const tabsPlaced = useRef(false);
  useLayoutEffect(() => {
    const nav = tabsRef.current;
    const el = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !el) return;
    // Centre the tab within the row only (scrollIntoView would also scroll the page).
    const left = el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: tabsPlaced.current ? 'smooth' : 'instant' });
    tabsPlaced.current = true;
  }, [tab, query, screen.name]);

  if (screen.name === 'title')
    return (
      <>
        <TitlePage who={who} itemKey={screen.key} back={back} open={open} play={play} now={now} pad={pad} openRemote={() => setRemoteOpen(true)} openDownloads={openDownloads} />
        {remote}
      </>
    );

  return (
    <div className={`min-h-[100dvh] ${pad}`}>
      <header
        className={`sticky top-0 z-30 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] transition-[background-color,padding,box-shadow] duration-300 ${
          scrolled ? 'bg-[#141414]/95 pb-3 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-md' : 'bg-gradient-to-b from-black/90 via-black/60 to-transparent pb-6'
        }`}
      >
        <button onClick={() => setTab('home')} aria-label="TruongFlix home">
          <Wordmark className="text-3xl" />
        </button>
        {/* On phones the sections wrap onto their own scrolling line under the logo. */}
        <nav
          ref={tabsRef}
          aria-label="Sections"
          className="relative order-last -mx-4 flex w-[calc(100%+2rem)] scroll-px-4 gap-2 overflow-x-auto px-4 pr-8 [scrollbar-width:none] max-md:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] md:order-none md:mx-0 md:w-auto md:gap-5 md:px-0"
        >
          {/* The current section's highlight slides sideways from tab to tab (a pill on phones, a line on wider screens). */}
          <SlidingPill row={tabsRef} watch={`${tab}:${query == null}`} className="rounded-full border border-white bg-white/15 md:hidden" />
          <SlidingPill row={tabsRef} watch={`${tab}:${query == null}`} line className="hidden bg-white md:block" />
          {TABS.map(({ tab: t, label }) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-current={tab === t && query == null ? 'page' : undefined}
              className={`relative shrink-0 whitespace-nowrap text-sm transition-colors [-webkit-tap-highlight-color:transparent] max-md:rounded-full max-md:border max-md:px-3 max-md:py-1 ${
                tab === t && query == null ? 'font-semibold text-white max-md:border-transparent' : 'text-white/70 hover:text-white max-md:border-white/30'
              }`}
            >
              <span className="relative">{label}</span>
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <button onClick={() => setQuery(query == null ? '' : null)} aria-label={query == null ? 'Search' : 'Close search'} className="p-2">
          {query == null ? <Search className="h-6 w-6" /> : <X className="h-6 w-6" />}
        </button>
        <button onClick={openDownloads} aria-label="Downloads" title="Downloads" className="p-2">
          <Download className="h-6 w-6" />
        </button>
        <button onClick={switchProfile} title="Switch profile" aria-label="Switch profile">
          <ProfileAvatar color={who.profile.color} maturity={who.profile.maturity} size={30} />
        </button>
      </header>
      {query != null && (
        <div className="nf-fade px-4">
          <input
            autoFocus
            type="search"
            enterKeyHint="search"
            aria-label="Search your library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery(null)}
            placeholder="Titles, years, genres"
            className="w-full rounded bg-white/10 px-4 py-3 outline-none placeholder:text-white/50"
          />
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
            {results.map((i) => (
              <Poster key={i.key} item={i} onClick={() => open(i.key)} className="w-full" />
            ))}
          </div>
          {query.trim() && lib && !results.length && <p className="py-10 text-center text-nf-secondary">Nothing in your library matches “{query.trim()}”.</p>}
        </div>
      )}
      {error && <p className="px-4 text-nf-red">{error}</p>}
      <Entrance key={query == null ? tab : 'search'} back={cameBack}>
      {query == null && tab === 'live' && (
        <RemoteLiveSection who={who} onAuthError={onAuthError} onPlayedOnPc={() => { now.refresh(); setRemoteOpen(true); }} />
      )}
      {query == null && tab === 'music' && <RemoteMusicSection />}
      {query == null && lib && tab === 'mylist' && (
        <div className="px-4">
          <h1 className="mb-4 text-2xl font-bold">My List</h1>
          {(lib.rows.find((r) => r.title === 'My List')?.items.length ?? 0) > 0 ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
              {lib.rows.find((r) => r.title === 'My List')!.items.map((i) => <Poster key={i.key} item={i} onClick={() => open(i.key)} className="w-full" />)}
            </div>
          ) : (
            <p className="py-10 text-center text-nf-secondary">Titles you add to My List show up here.</p>
          )}
        </div>
      )}
      {query == null && lib && (tab === 'tv' || tab === 'movies') && (() => {
        const kind = tab === 'tv' ? 'tv' : 'movie';
        const pool = lib.all.filter((i) => i.kind === kind && i.backdrop && i.overview);
        const featured = pool.length ? pool[featuredSeed % pool.length] : null;
        return (
          <>
            {featured && <Featured who={who} item={featured} open={open} play={(k) => void playKey(k)} />}
            {!featured && <h1 className="mb-4 px-4 text-2xl font-bold">{tab === 'tv' ? 'TV Shows' : 'Movies'}</h1>}
            {sectionRows(lib, kind).map((row, i) => <Row key={row.title} row={row} open={open} scope={tab} index={i} />)}
          </>
        );
      })()}
      {query == null && lib && tab === 'home' && (
        <>
          {lib.featured && <Featured who={who} item={lib.featured} open={open} play={(k) => void playKey(k)} />}
          {lib.rows.map((row, i) => <Row key={row.title} row={row} open={open} scope="home" index={i} />)}
        </>
      )}
      </Entrance>
      {remote}
    </div>
  );
}
