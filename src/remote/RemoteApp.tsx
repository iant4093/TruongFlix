import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Lock, Play, Search, X } from 'lucide-react';
import ProfileAvatar from '../components/common/ProfileAvatar';
import type { RemoteItem, RemoteLibrary, RemotePlayable, RemoteProfile, RemoteTitle } from './types';
import { api, AuthError, getToken, login, qs } from './api';
import RemotePlayer from './RemotePlayer';

type Who = { id: number; key?: string; profile: RemoteProfile };
type Screen = { name: 'home' } | { name: 'title'; key: string } | { name: 'play'; target: RemotePlayable };

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

  const choose = (w: Who | null) => {
    setWho(w);
    if (w) sessionStorage.setItem('tf-remote-who', JSON.stringify(w));
    else sessionStorage.removeItem('tf-remote-who');
    setScreen({ name: 'home' });
  };
  const onAuthError = useCallback((e: unknown) => {
    if (e instanceof AuthError) setSignedIn(false);
  }, []);

  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;
  if (!who) return <Profiles onPick={choose} onAuthError={onAuthError} />;
  if (screen.name === 'play')
    return <RemotePlayer who={who} target={screen.target} onExit={() => setScreen({ name: 'home' })} onPlay={(t) => setScreen({ name: 'play', target: t })} />;
  return (
    <Browse
      who={who}
      screen={screen}
      open={(key) => setScreen({ name: 'title', key })}
      play={(target) => setScreen({ name: 'play', target })}
      back={() => setScreen({ name: 'home' })}
      switchProfile={() => choose(null)}
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
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
      setError(e instanceof Error ? e.message : String(e));
      setPin('');
    }
  };
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6">
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
      {locked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-6" onClick={() => setLocked(null)}>
          <div className="w-full max-w-xs text-center" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-medium">Enter {locked.name}’s PIN</h2>
            <input
              value={pin}
              autoFocus
              inputMode="numeric"
              type="password"
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                setPin(v);
                if (v.length === 4) void unlock(locked, v);
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

function Poster({ item, onClick }: { item: RemoteItem; onClick: () => void }) {
  const art = item.poster ?? item.backdrop;
  return (
    <button onClick={onClick} className="w-28 shrink-0 text-left sm:w-36">
      <div className="relative aspect-[2/3] overflow-hidden rounded bg-white/10">
        {art ? <img src={art} alt={item.title} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center p-2 text-sm font-bold">{item.title}</div>}
        {item.progress != null && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/30">
            <div className="h-full bg-nf-red" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
        )}
      </div>
      {item.hint && <div className="mt-1 truncate text-xs text-nf-secondary">{item.hint}</div>}
    </button>
  );
}

function Browse({
  who,
  screen,
  open,
  play,
  back,
  switchProfile,
  onAuthError,
}: {
  who: Who;
  screen: Screen;
  open: (key: string) => void;
  play: (t: RemotePlayable) => void;
  back: () => void;
  switchProfile: () => void;
  onAuthError: (e: unknown) => void;
}) {
  const [lib, setLib] = useState<RemoteLibrary | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    api<RemoteLibrary>(`/library${qs({ profile: who.id, key: who.key })}`)
      .then(setLib)
      .catch((e) => {
        onAuthError(e);
        setError(String(e instanceof Error ? e.message : e));
      });
  }, [who, screen.name, onAuthError]);

  const results = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    return q && lib ? lib.all.filter((i) => i.title.toLowerCase().includes(q)) : [];
  }, [query, lib]);

  if (screen.name === 'title') return <TitlePage who={who} itemKey={screen.key} back={back} play={play} />;

  return (
    <div className="min-h-[100dvh] pb-16">
      <header className="sticky top-0 z-30 flex items-center gap-3 bg-gradient-to-b from-black/90 to-transparent px-4 pb-6 pt-[max(1rem,env(safe-area-inset-top))]">
        <Wordmark className="text-3xl" />
        <div className="flex-1" />
        <button onClick={() => setQuery(query == null ? '' : null)} aria-label="Search" className="p-2">
          {query == null ? <Search className="h-6 w-6" /> : <X className="h-6 w-6" />}
        </button>
        <button onClick={switchProfile} title="Switch profile">
          <ProfileAvatar color={who.profile.color} maturity={who.profile.maturity} size={30} />
        </button>
      </header>
      {query != null && (
        <div className="px-4">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library"
            className="w-full rounded bg-white/10 px-4 py-3 outline-none placeholder:text-white/50"
          />
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
            {results.map((i) => (
              <Poster key={i.key} item={i} onClick={() => open(i.key)} />
            ))}
          </div>
        </div>
      )}
      {error && <p className="px-4 text-nf-red">{error}</p>}
      {query == null && lib && (
        <>
          {lib.featured && (
            <section className="relative -mt-24 mb-6 aspect-[3/4] max-h-[75vh] w-full overflow-hidden sm:aspect-video">
              <img src={lib.featured.backdrop ?? lib.featured.poster ?? ''} alt="" className="absolute inset-0 h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-nf-bg via-nf-bg/30 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-4 px-6 pb-6 text-center">
                {lib.featured.logo ? (
                  <img src={lib.featured.logo} alt={lib.featured.title} className="max-h-24 max-w-[70%] object-contain" />
                ) : (
                  <h1 className="text-4xl font-black">{lib.featured.title}</h1>
                )}
                <div className="flex gap-3">
                  <button onClick={() => open(lib.featured!.key)} className="nf-btn-play px-8">
                    <Play className="h-5 w-5 fill-black" strokeWidth={0} /> Play
                  </button>
                </div>
              </div>
            </section>
          )}
          {lib.rows.map((row) => (
            <section key={row.title} className="mb-6">
              <h2 className="mb-2 px-4 text-lg font-semibold">{row.title}</h2>
              <div className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
                {row.items.map((i) => (
                  <Poster key={`${row.title}-${i.key}`} item={i} onClick={() => open(i.key)} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function TitlePage({ who, itemKey, back, play }: { who: Who; itemKey: string; back: () => void; play: (t: RemotePlayable) => void }) {
  const [data, setData] = useState<RemoteTitle | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  useEffect(() => {
    api<RemoteTitle>(`/title${qs({ profile: who.id, key: who.key, item: itemKey })}`).then((d) => {
      setData(d);
      const current = d.episodes.find((e) => e.id === d.play?.id);
      setSeason(current?.season ?? d.episodes[0]?.season ?? null);
    });
  }, [who, itemKey]);
  if (!data) return <div className="flex min-h-[100dvh] items-center justify-center text-nf-secondary">Loading…</div>;
  const { item } = data;
  const seasons = [...new Set(data.episodes.map((e) => e.season))];
  const list = data.episodes.filter((e) => e.season === season);
  return (
    <div className="min-h-[100dvh] pb-16">
      <div className="relative aspect-video max-h-[60vh] w-full overflow-hidden">
        {item.backdrop && <img src={item.backdrop} alt="" className="h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-nf-bg to-transparent" />
        <button onClick={back} aria-label="Back" className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] rounded-full bg-black/60 p-2">
          <ArrowLeft className="h-6 w-6" />
        </button>
      </div>
      <div className="mx-auto max-w-3xl space-y-4 px-4">
        {item.logo ? <img src={item.logo} alt={item.title} className="max-h-20 max-w-[70%] object-contain" /> : <h1 className="text-3xl font-black">{item.title}</h1>}
        <div className="flex flex-wrap items-center gap-2 text-sm text-nf-secondary">
          {item.year && <span>{item.year}</span>}
          {item.certification && <span className="border border-white/40 px-1 text-xs">{item.certification}</span>}
          {item.kind === 'tv' ? <span>{item.seasonCount} Season{item.seasonCount === 1 ? '' : 's'}</span> : item.runtime ? <span>{Math.floor(item.runtime / 60)}h {item.runtime % 60}m</span> : null}
          {item.imdbRating != null && <span className="font-semibold text-[#f5c518]">IMDb {item.imdbRating.toFixed(1)}</span>}
        </div>
        {data.play && (
          <button onClick={() => play(data.play!)} className="nf-btn-play w-full justify-center py-3 text-lg sm:w-auto sm:px-10">
            <Play className="h-6 w-6 fill-black" strokeWidth={0} />
            {data.play.resume > 0 ? 'Resume' : 'Play'}
            {item.kind === 'tv' && <span className="text-base font-medium text-black/60">{data.play.label.match(/S\d+:E\d+/)?.[0]}</span>}
          </button>
        )}
        <p className="leading-relaxed">{item.overview}</p>
        {data.cast.length > 0 && <p className="text-sm text-nf-secondary">Cast: {data.cast.join(', ')}</p>}
        {seasons.length > 0 && (
          <section className="pt-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-bold">Episodes</h2>
              {seasons.length > 1 && (
                <select value={season ?? ''} onChange={(e) => setSeason(Number(e.target.value))} className="rounded border border-white/30 bg-[#242424] px-3 py-2">
                  {seasons.map((s) => (
                    <option key={s} value={s}>
                      {s === 0 ? 'Specials' : `Season ${s}`}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="divide-y divide-white/10">
              {list.map((e) => (
                <button key={e.id} onClick={() => play({ type: 'episode', id: e.id, label: `S${e.season}:E${e.episode} · ${e.title}`, resume: -1 })} className="flex w-full gap-3 py-3 text-left">
                  <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded bg-white/10">
                    {e.still && <img src={e.still} alt="" loading="lazy" className="h-full w-full object-cover" />}
                    {e.progress > 0 && (
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/30">
                        <div className="h-full bg-nf-red" style={{ width: `${Math.round(e.progress * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {e.episode}. {e.title}
                    </div>
                    <div className="text-xs text-nf-muted">{e.runtime ? `${e.runtime}m` : ''}{e.watched ? ' · Watched' : ''}</div>
                    {e.overview && <p className="mt-1 line-clamp-2 text-sm text-nf-secondary">{e.overview}</p>}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
