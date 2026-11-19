import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import SlidingPill from '../../components/common/SlidingPill';
import { ArrowDown, ArrowUp, ChevronLeft, Heart, ListMusic, Music2, Pencil, Play, Plus, Search, Shuffle, Trash2, X } from 'lucide-react';
import { createPlaylist, deletePlaylist, loadMusicLibrary, moveInList, renamePlaylist, setPlaylistTracks, useMusicLoad } from '../actions';
import { byName, formatTotal, listenNow, playlistArt, searchMusic } from '../library';
import { currentRoute, goBack, MUSIC_TABS, musicToast, openRoute, openTab, setMusicQuery, takeScroll, useMusicNav, type MusicRoute } from '../nav';
import { playTracks, useMusicPlayer } from '../player';
import type { MusicAlbum, MusicArtist, MusicLibrary as Library, MusicPlaylist, MusicTrack } from '../types';
import { askConfirm, askName } from './Overlays';
import TrackList from './TrackList';
import TrackMenu from './TrackMenu';
import { Cover, Mosaic } from './ui';
import { errorMessage } from '../../lib/errors';

const ACCENT = 'bg-[#fa2d48] hover:bg-[#ff4560]';

interface Props {
  /** Desktop app (wide, under the main navbar) or the browser app on a phone. */
  variant: 'desktop' | 'phone';
  /** Shown when the library is empty (e.g. a button to add a music folder). */
  emptyAction?: ReactNode;
  /** Extra controls at the right of the header (phone: profile button). */
  headerExtra?: ReactNode;
}

/** The music library: Listen Now, Albums, Artists, Songs, Playlists, Favourites and search. */
export default function MusicLibrary({ variant, emptyAction, headerExtra }: Props) {
  const library = useMusicPlayer((s) => s.library);
  const api = useMusicPlayer((s) => s.api);
  const { error } = useMusicLoad();
  const route = useMusicNav(currentRoute);
  const query = useMusicNav((s) => s.query);
  const depth = useMusicNav((s) => s.stack.length);
  const hasTrack = useMusicPlayer((s) => !!s.track);
  const phone = variant === 'phone';
  const tabRow = useRef<HTMLElement>(null);

  useEffect(() => {
    if (api) void loadMusicLibrary();
  }, [api]);
  // A new page starts at the top and Back returns to where you were. Not on mount: coming back to
  // Music restores the section's own position.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    window.scrollTo({ top: takeScroll(), behavior: 'instant' });
  }, [route]);

  const tab = 'id' in route ? null : route.page;
  // Pages slide in from the right when opened and from the left on Back; tabs and search fade.
  const stack = useMusicNav((s) => s.stack);
  const last = useRef({ depth, route });
  const prev = last.current;
  const motionClass = prev.route === route ? '' : depth > prev.depth ? 'tfm-push' : depth < prev.depth ? 'tfm-pop' : 'tfm-fade';
  useEffect(() => {
    last.current = { depth, route };
  }, [depth, route]);
  const pageKey = query.trim() ? 'search' : `${stack.length}:${JSON.stringify(route)}`;
  const body = !library ? (
    <div className="py-24 text-center text-white/50">{error ? `Couldn’t load your music: ${error}` : 'Loading your music…'}</div>
  ) : !library.tracks.length ? (
    <Empty action={emptyAction} phone={phone} />
  ) : query.trim() ? (
    <SearchResults library={library} query={query} />
  ) : (
    <Page route={route} library={library} phone={phone} />
  );

  return (
    <div className={phone ? `min-h-[100dvh] ${hasTrack ? 'pb-36' : 'pb-16'}` : `min-h-screen px-[4%] pt-24 ${hasTrack ? 'pb-36' : 'pb-20'}`}>
      <header className={phone ? 'relative px-4 pb-4 pt-1' : 'mb-6'}>
        <div className="flex items-center gap-3">
          {depth > 1 && !query ? (
            <button type="button" onClick={goBack} aria-label="Back" className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full text-[#fa2d48] hover:bg-white/10">
              <ChevronLeft className="h-7 w-7" />
            </button>
          ) : null}
          <h1 className={`font-bold tracking-tight ${phone ? 'text-3xl' : 'text-4xl'}`}>Music</h1>
          <div className="flex-1" />
          <SearchBox phone={phone} />
          {headerExtra}
        </div>
        {/* On narrow screens the row scrolls; its right edge fades so the hidden tabs read as more. */}
        <nav ref={tabRow} aria-label="Music sections" className="tfm-scroll relative -mx-1 mt-4 flex gap-2 overflow-x-auto px-1 max-sm:-mr-4 max-sm:pr-8 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]">
          {/* The white highlight slides sideways from tab to tab. */}
          <SlidingPill row={tabRow} watch={`${tab}:${!!query}`} className="rounded-full bg-white" />
          {MUSIC_TABS.map((t) => (
            <button
              key={t.tab}
              type="button"
              onClick={() => openTab(t.tab)}
              aria-current={tab === t.tab && !query ? 'page' : undefined}
              className={`relative shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors duration-300 [-webkit-tap-highlight-color:transparent] ${tab === t.tab && !query ? 'text-black' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
            >
              <span className="relative">{t.label}</span>
            </button>
          ))}
        </nav>
      </header>
      <div key={pageKey} className={`${phone ? 'px-4' : ''} ${query.trim() ? '' : motionClass}`}>
        {body}
      </div>
    </div>
  );
}

function SearchBox({ phone }: { phone: boolean }) {
  const query = useMusicNav((s) => s.query);
  const [open, setOpen] = useState(!phone || !!query);
  const input = useRef<HTMLInputElement>(null);
  if (phone && !open)
    return (
      <button type="button" aria-label="Search music" onClick={() => { setOpen(true); setTimeout(() => input.current?.focus(), 0); }} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10">
        <Search className="h-6 w-6" />
      </button>
    );
  return (
    <div className={`flex h-10 items-center gap-2 rounded-xl bg-white/10 px-3 ${phone ? 'nf-fade absolute inset-x-4 top-1 z-10 bg-[#2c2c2e]' : 'w-72'}`}>
      <Search className="h-4 w-4 shrink-0 text-white/50" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setMusicQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setMusicQuery('');
            if (phone) setOpen(false);
          }
        }}
        aria-label="Search music"
        placeholder="Songs, albums, artists"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-white/40"
      />
      {(query || phone) && (
        <button type="button" aria-label="Clear search" onClick={() => { setMusicQuery(''); if (phone) setOpen(false); }} className="text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function Empty({ action, phone }: { action?: ReactNode; phone: boolean }) {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-[#fa2d48] to-[#a8173b] shadow-lg">
        <Music2 className="h-10 w-10" />
      </div>
      <h2 className="text-2xl font-bold">No music yet</h2>
      <p className="max-w-md text-white/60">
        {phone ? 'Add a music folder in TruongFlix on your computer (Settings › Library), then scan.' : 'Add a folder with your music in Settings › Library and TruongFlix will read its songs, covers and lyrics.'}
      </p>
      {action}
    </div>
  );
}

function Page({ route, library, phone }: { route: MusicRoute; library: Library; phone: boolean }) {
  switch (route.page) {
    case 'listen':
      return <ListenNow library={library} />;
    case 'albums':
      return <Albums library={library} />;
    case 'artists':
      return <Artists artists={library.artists} />;
    case 'songs':
      return <Songs tracks={library.tracks} />;
    case 'playlists':
      return <Playlists library={library} />;
    case 'favourites':
      return <Favourites tracks={library.tracks} />;
    case 'album':
      return <AlbumPage library={library} id={route.id} phone={phone} />;
    case 'artist':
      return <ArtistPage library={library} id={route.id} />;
    case 'playlist':
      return <PlaylistPage library={library} id={route.id} phone={phone} />;
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Shelf({ title, children, onMore }: { title: string; children: ReactNode; onMore?: () => void }) {
  return (
    <section className="mb-9">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xl font-bold">{title}</h2>
        {onMore && (
          <button type="button" onClick={onMore} className="text-sm font-semibold text-[#fa2d48] hover:underline">
            See All
          </button>
        )}
      </div>
      <div className="tfm-scroll -mx-1 flex gap-4 overflow-x-auto px-1 pb-1">{children}</div>
    </section>
  );
}

export function AlbumCard({ album, className = 'w-40 sm:w-44 shrink-0' }: { album: MusicAlbum; className?: string }) {
  return (
    <div className={`group text-left ${className}`}>
      <div className="relative">
        <button type="button" onClick={() => openRoute({ page: 'album', id: album.id })} className="tfm-press block w-full" aria-label={`${album.title} by ${album.artist}`}>
          <Cover art={album.art} alt="" className="w-full shadow-lg transition group-hover:brightness-90" rounded="rounded-lg" />
        </button>
        <button
          type="button"
          aria-label={`Play ${album.title}`}
          onClick={() => playTracks(album.trackIds, 0)}
          className="absolute bottom-2 left-2 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow-lg backdrop-blur transition hover:scale-105 hover:bg-[#fa2d48] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Play className="ml-0.5 h-5 w-5 fill-current" strokeWidth={0} />
        </button>
      </div>
      <button type="button" onClick={() => openRoute({ page: 'album', id: album.id })} className="mt-2 block w-full text-left">
        <div className="truncate text-sm font-medium">{album.title}</div>
        <div className="truncate text-sm text-white/55">{album.artist}</div>
      </button>
    </div>
  );
}

function PlayButtons({ ids, className = '' }: { ids: number[]; className?: string }) {
  return (
    <div className={`flex gap-3 ${className}`}>
      <button type="button" disabled={!ids.length} onClick={() => playTracks(ids, 0, { shuffle: false })} className={`flex h-11 min-w-[8.5rem] items-center justify-center gap-2 rounded-lg px-5 font-semibold text-white disabled:opacity-40 ${ACCENT}`}>
        <Play className="h-4 w-4 fill-current" strokeWidth={0} /> Play
      </button>
      <button type="button" disabled={!ids.length} onClick={() => playTracks(ids, Math.floor(Math.random() * ids.length), { shuffle: true })} className="flex h-11 min-w-[8.5rem] items-center justify-center gap-2 rounded-lg bg-white/10 px-5 font-semibold text-[#fa2d48] hover:bg-white/15 disabled:opacity-40">
        <Shuffle className="h-4 w-4" /> Shuffle
      </button>
    </div>
  );
}

/** Renders long lists a few hundred rows at a time. */
function useIncremental<T>(list: T[], step = 200) {
  const [count, setCount] = useState(step);
  const sentinel = useRef<HTMLDivElement>(null);
  // Start over only when the songs themselves change: a play count or a favourite updates the list
  // too, and used to jump a deep-scrolled list back to the first rows.
  const ids = list.map((x) => (x as { id?: unknown }).id ?? x).join(',');
  useEffect(() => setCount(step), [ids, step]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || count >= list.length || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && setCount((c) => c + step), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [count, list.length, step]);
  return { shown: list.slice(0, count), sentinel: count < list.length ? <div ref={sentinel} className="h-10" /> : null };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function ListenNow({ library }: { library: Library }) {
  const ln = useMemo(() => listenNow(library), [library]);
  return (
    <>
      {ln.recent.length > 0 && (
        <Shelf title="Recently Played">
          {ln.recent.map((a) => <AlbumCard key={a.id} album={a} />)}
        </Shelf>
      )}
      {ln.top.length > 0 && (
        <Shelf title="Most Played">
          {ln.top.map((a) => <AlbumCard key={a.id} album={a} />)}
        </Shelf>
      )}
      <Shelf title="Recently Added" onMore={() => openTab('albums')}>
        {ln.added.map((a) => <AlbumCard key={a.id} album={a} />)}
      </Shelf>
      {ln.topSongs.length > 0 && (
        <section className="mb-9">
          <h2 className="mb-2 text-xl font-bold">Top Songs</h2>
          <TrackList tracks={ln.topSongs} />
        </section>
      )}
    </>
  );
}

type AlbumSort = 'title' | 'artist' | 'added' | 'year';

function Albums({ library }: { library: Library }) {
  const [sort, setSort] = useState<AlbumSort>('title');
  const albums = useMemo(() => {
    const list = [...library.albums];
    if (sort === 'artist') list.sort((a, b) => byName(a.artist, b.artist) || (a.year ?? 0) - (b.year ?? 0));
    else if (sort === 'added') list.sort((a, b) => b.addedAt - a.addedAt);
    else if (sort === 'year') list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || byName(a.title, b.title));
    return list;
  }, [library.albums, sort]);
  const { shown, sentinel } = useIncremental(albums, 120);
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-white/50">{albums.length} albums</span>
        <label className="flex items-center gap-2 text-sm text-white/60">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value as AlbumSort)} className="rounded-lg border border-white/15 bg-[#2c2c2e] px-2 py-1.5 text-white">
            <option value="title">Title</option>
            <option value="artist">Artist</option>
            <option value="added">Recently Added</option>
            <option value="year">Year</option>
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
        {shown.map((a) => <AlbumCard key={a.id} album={a} className="min-w-0" />)}
      </div>
      {sentinel}
    </>
  );
}

function Artists({ artists }: { artists: MusicArtist[] }) {
  const { shown, sentinel } = useIncremental(artists, 200);
  return (
    <div className="divide-y divide-white/[0.07]">
      {shown.map((a) => (
        <button key={a.id} type="button" onClick={() => openRoute({ page: 'artist', id: a.id })} className="tfm-press-row flex w-full items-center gap-4 rounded-lg px-2 py-2 text-left hover:bg-white/[0.06]">
          <Cover art={a.art} className="h-14 w-14 shrink-0" rounded="rounded-full" />
          <div className="min-w-0">
            <div className="truncate font-medium">{a.name}</div>
            <div className="text-sm text-white/50">
              {a.albumIds.length ? `${a.albumIds.length} album${a.albumIds.length === 1 ? '' : 's'} · ` : ''}
              {a.trackCount} song{a.trackCount === 1 ? '' : 's'}
            </div>
          </div>
        </button>
      ))}
      {sentinel}
    </div>
  );
}

function Songs({ tracks }: { tracks: MusicTrack[] }) {
  const { shown, sentinel } = useIncremental(tracks, 250);
  const ids = useMemo(() => tracks.map((t) => t.id), [tracks]);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-white/50">{tracks.length} songs</span>
        <PlayButtons ids={ids} />
      </div>
      <TrackList tracks={shown} />
      {sentinel}
    </div>
  );
}

function Favourites({ tracks }: { tracks: MusicTrack[] }) {
  const favs = useMemo(() => tracks.filter((t) => t.favourite), [tracks]);
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-5">
        <div className="flex h-28 w-28 items-center justify-center rounded-xl bg-gradient-to-br from-[#fa2d48] to-[#7a1530] shadow-lg">
          <Heart className="h-12 w-12 fill-white" />
        </div>
        <div>
          <h2 className="text-2xl font-bold">Favourite Songs</h2>
          <p className="text-sm text-white/55">{favs.length} songs</p>
          <PlayButtons ids={favs.map((t) => t.id)} className="mt-3" />
        </div>
      </div>
      {favs.length ? <TrackList tracks={favs} /> : <p className="py-10 text-center text-white/50">Tap the heart on any song to add it here.</p>}
    </div>
  );
}

function Playlists({ library }: { library: Library }) {
  const byId = useMusicPlayer((s) => s.byId);
  const create = async () => {
    const name = await askName('New Playlist', '', 'Create');
    if (!name) return;
    try {
      const p = await createPlaylist(name);
      openRoute({ page: 'playlist', id: p.id });
    } catch (e) {
      musicToast(errorMessage(e));
    }
  };
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      <button type="button" onClick={() => void create()} className="tfm-press group min-w-0 text-left">
        <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-white/25 bg-white/[0.04] text-white/60 transition group-hover:bg-white/[0.08] group-hover:text-white">
          <Plus className="h-10 w-10" />
        </div>
        <div className="mt-2 text-sm font-medium">New Playlist</div>
      </button>
      {library.playlists.map((p) => (
        <button key={p.id} type="button" onClick={() => openRoute({ page: 'playlist', id: p.id })} className="tfm-press min-w-0 text-left">
          <Mosaic arts={playlistArt(byId, p)} className="w-full shadow-lg" />
          <div className="mt-2 truncate text-sm font-medium">{p.name}</div>
          <div className="text-sm text-white/50">
            {p.trackIds.length} song{p.trackIds.length === 1 ? '' : 's'}
          </div>
        </button>
      ))}
    </div>
  );
}

function SearchResults({ library, query }: { library: Library; query: string }) {
  const r = useMemo(() => searchMusic(library, query), [library, query]);
  if (!r.tracks.length && !r.albums.length && !r.artists.length) return <p className="py-16 text-center text-white/50">No results for “{query}”.</p>;
  return (
    <>
      {r.artists.length > 0 && (
        <Shelf title="Artists">
          {r.artists.map((a) => (
            <button key={a.id} type="button" onClick={() => openRoute({ page: 'artist', id: a.id })} className="tfm-press w-32 shrink-0 text-center">
              <Cover art={a.art} rounded="rounded-full" className="w-full shadow-lg" />
              <div className="mt-2 truncate text-sm font-medium">{a.name}</div>
            </button>
          ))}
        </Shelf>
      )}
      {r.albums.length > 0 && <Shelf title="Albums">{r.albums.map((a) => <AlbumCard key={a.id} album={a} />)}</Shelf>}
      {r.tracks.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-bold">Songs</h2>
          <TrackList tracks={r.tracks} />
        </section>
      )}
    </>
  );
}

function DetailHeader({ art, mosaic, title, subtitle, meta, ids, actions, phone, round = false, onSubtitle }: { art?: string | null; mosaic?: string[]; title: string; subtitle?: string; meta?: string; ids: number[]; actions?: ReactNode; phone: boolean; round?: boolean; onSubtitle?: () => void }) {
  return (
    <div className={`mb-6 flex gap-6 ${phone ? 'flex-col items-center text-center' : 'items-end'}`}>
      {mosaic ? (
        <Mosaic arts={mosaic} className={`${phone ? 'w-60' : 'w-56'} shrink-0 shadow-2xl`} />
      ) : (
        <Cover art={art ?? null} className={`${phone ? 'w-60' : 'w-56'} shrink-0 shadow-2xl`} rounded={round ? 'rounded-full' : 'rounded-xl'} />
      )}
      <div className="min-w-0">
        <h2 className={`font-bold leading-tight ${phone ? 'text-2xl' : 'text-4xl'}`}>{title}</h2>
        {subtitle &&
          (onSubtitle ? (
            <button type="button" onClick={onSubtitle} className="mt-1 text-xl text-[#fa2d48] hover:underline">
              {subtitle}
            </button>
          ) : (
            <div className="mt-1 text-xl text-[#fa2d48]">{subtitle}</div>
          ))}
        {meta && <div className="mt-1 text-sm uppercase tracking-wide text-white/50">{meta}</div>}
        <div className={`mt-5 flex flex-wrap items-center gap-3 ${phone ? 'justify-center' : ''}`}>
          <PlayButtons ids={ids} />
          {actions}
        </div>
      </div>
    </div>
  );
}

function AlbumPage({ library, id, phone }: { library: Library; id: number; phone: boolean }) {
  const byId = useMusicPlayer((s) => s.byId);
  const album = library.albums.find((a) => a.id === id);
  if (!album) return <p className="py-16 text-center text-white/50">This album is no longer in your library.</p>;
  const tracks = album.trackIds.map((t) => byId.get(t)).filter((t): t is MusicTrack => !!t);
  const variousArtists = tracks.some((t) => t.artist !== album.artist);
  return (
    <div>
      <DetailHeader
        art={album.art}
        title={album.title}
        subtitle={album.artist}
        onSubtitle={() => openRoute({ page: 'artist', id: album.artistId })}
        meta={[album.genre, album.year].filter(Boolean).join(' · ')}
        ids={album.trackIds}
        phone={phone}
        actions={<TrackMenu tracks={tracks} className="!h-11 !w-11 bg-white/10" label="More album options" />}
      />
      <TrackList tracks={tracks} lead="number" showAlbum={false} showArtist={variousArtists} />
      <p className="mt-4 text-sm text-white/45">
        {tracks.length} song{tracks.length === 1 ? '' : 's'}, {formatTotal(album.duration)}
      </p>
    </div>
  );
}

function ArtistPage({ library, id }: { library: Library; id: number }) {
  const artist = library.artists.find((a) => a.id === id);
  const songs = useMemo(
    () => library.tracks.filter((t) => t.artistId === id || t.albumArtistId === id).sort((a, b) => b.plays - a.plays || byName(a.title, b.title)),
    [library.tracks, id],
  );
  if (!artist) return <p className="py-16 text-center text-white/50">This artist is no longer in your library.</p>;
  const albums = artist.albumIds.map((a) => library.albums.find((x) => x.id === a)).filter((a): a is MusicAlbum => !!a);
  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end gap-6">
        <Cover art={artist.art} rounded="rounded-full" className="w-40 shrink-0 shadow-2xl sm:w-48" />
        <div>
          <h2 className="text-4xl font-bold">{artist.name}</h2>
          <PlayButtons ids={songs.map((t) => t.id)} className="mt-4" />
        </div>
      </div>
      {albums.length > 0 && (
        <section className="mb-9">
          <h3 className="mb-3 text-xl font-bold">Albums</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {albums.map((a) => <AlbumCard key={a.id} album={a} className="min-w-0" />)}
          </div>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-xl font-bold">Songs</h3>
        <TrackList tracks={songs.slice(0, 50)} />
      </section>
    </div>
  );
}

function PlaylistPage({ library, id, phone }: { library: Library; id: number; phone: boolean }) {
  const byId = useMusicPlayer((s) => s.byId);
  const [editing, setEditing] = useState(false);
  const playlist: MusicPlaylist | undefined = library.playlists.find((p) => p.id === id);
  if (!playlist) return <p className="py-16 text-center text-white/50">This playlist was deleted.</p>;
  const tracks = playlist.trackIds.map((t) => byId.get(t)).filter((t): t is MusicTrack => !!t);
  const duration = tracks.reduce((s, t) => s + t.duration, 0);
  const save = (ids: number[]) => void setPlaylistTracks(playlist.id, ids).catch((e) => musicToast(errorMessage(e)));
  const move = (from: number, to: number) => save(moveInList(playlist.trackIds, from, to));
  const rename = async () => {
    const name = await askName('Rename Playlist', playlist.name);
    if (name && name !== playlist.name) await renamePlaylist(playlist.id, name).catch((e) => musicToast(errorMessage(e)));
  };
  const remove = async () => {
    if (!(await askConfirm(`Delete “${playlist.name}”?`, 'The songs stay in your library.', 'Delete'))) return;
    goBack();
    await deletePlaylist(playlist.id).catch((e) => musicToast(errorMessage(e)));
  };
  const btn = 'flex h-11 items-center gap-2 rounded-lg bg-white/10 px-4 text-sm font-semibold hover:bg-white/15';
  return (
    <div>
      <DetailHeader
        mosaic={playlistArt(byId, playlist)}
        title={playlist.name}
        meta={`${tracks.length} song${tracks.length === 1 ? '' : 's'}${duration ? ` · ${formatTotal(duration)}` : ''}`}
        ids={playlist.trackIds.filter((t) => byId.has(t))}
        phone={phone}
        actions={
          <>
            <button type="button" onClick={() => setEditing((e) => !e)} aria-pressed={editing} className={`${btn} ${editing ? '!bg-white !text-black' : ''}`}>
              <ListMusic className="h-4 w-4" /> {editing ? 'Done' : 'Edit'}
            </button>
            <button type="button" onClick={() => void rename()} className={btn} aria-label="Rename playlist">
              <Pencil className="h-4 w-4" /> {phone ? '' : 'Rename'}
            </button>
            <button type="button" onClick={() => void remove()} className={`${btn} text-[#ff6b7d]`} aria-label="Delete playlist">
              <Trash2 className="h-4 w-4" /> {phone ? '' : 'Delete'}
            </button>
          </>
        }
      />
      {!tracks.length && <p className="py-10 text-center text-white/50">Add songs from any song’s “…” menu.</p>}
      {editing ? (
        <div className="divide-y divide-white/[0.07]">
          {tracks.map((t, i) => (
            <div key={`${t.id}-${i}`} className="flex items-center gap-3 px-2 py-1.5">
              <Cover art={t.art} className="h-10 w-10 shrink-0" rounded="rounded" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px]">{t.title}</div>
                <div className="truncate text-[13px] text-white/50">{t.artist}</div>
              </div>
              <button type="button" aria-label={`Move ${t.title} up`} disabled={i === 0} onClick={() => move(i, i - 1)} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-30">
                <ArrowUp className="h-5 w-5" />
              </button>
              <button type="button" aria-label={`Move ${t.title} down`} disabled={i === tracks.length - 1} onClick={() => move(i, i + 1)} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-30">
                <ArrowDown className="h-5 w-5" />
              </button>
              <button type="button" aria-label={`Remove ${t.title}`} onClick={() => save(playlist.trackIds.filter((_, k) => k !== i))} className="flex h-10 w-10 items-center justify-center rounded-full text-[#ff6b7d] hover:bg-white/10">
                <X className="h-5 w-5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <TrackList tracks={tracks} playlistId={playlist.id} onMove={move} />
      )}
    </div>
  );
}
