import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Download, Music2, RefreshCw } from 'lucide-react';
import { useSectionState } from '../../../lib/sectionMemory';
import { loadMusicLibrary } from '../../../music/actions';
import { useMusicPlayer } from '../../../music/player';
import {
  albumKey,
  chartAlbums,
  chartCountry,
  GENRES,
  newReleases,
  searchAlbums,
  searchArtists,
  searchSongs,
  topArtists,
  type CatalogAlbum,
  type CatalogArtist,
} from '../../../services/musicCatalog';
import { initMusicDownloads, isActive, useMusicDownloads } from '../../../services/musicDownloads';
import useCatalogQuery from '../../../hooks/useCatalogQuery';
import SearchField from '../../common/SearchField';
import { Bone } from '../../common/Skeleton';
import { ALBUM_GRID, AlbumTile, ArtistBubble, CoverArt, GridSkeleton, SHELF_TILE, Shelf, type TileState } from './MusicArt';
import MusicAlbumDialog from './MusicAlbumDialog';
import MusicArtistView from './MusicArtistView';
import MusicDownloadsDialog, { SoulseekDot } from './MusicDownloadsDialog';

const COUNTRY = chartCountry().toUpperCase();

function useDebounced<T>(value: T, ms: number) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setCurrent(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return current;
}

/**
 * Browse → Music: what's popular and new, genres, search, artists and albums, built like a
 * streaming service's browse page (square covers, rows that scroll sideways) rather than the
 * movie posters. Albums open a page with their tracklist and a Download button.
 */
export default function MusicBrowse({ kindControl }: { kindControl: ReactNode }) {
  const [query, setQuery] = useSectionState('music:query', '');
  const [genre, setGenre] = useSectionState<number | null>('music:genre', null);
  const [artist, setArtist] = useSectionState<CatalogArtist | null>('music:artist', null);
  const [album, setAlbum] = useState<CatalogAlbum | null>(null);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const search = useDebounced(query.trim(), 450);
  const library = useMusicPlayer((s) => s.library);
  const jobs = useMusicDownloads((s) => s.jobs);
  const status = useMusicDownloads((s) => s.status.state);
  const activeJobs = Object.values(jobs).filter(isActive).length;
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void initMusicDownloads().catch(() => {});
    void loadMusicLibrary();
  }, []);

  // Which albums are already yours, and which are downloading.
  const owned = useMemo(() => new Set((library?.albums ?? []).map((a) => albumKey(a.title, a.artist))), [library]);
  const jobByAlbum = useMemo(() => new Map(Object.values(jobs).map((j) => [albumKey(j.album, j.artist), j])), [jobs]);
  const tileState = (a: CatalogAlbum): TileState => {
    const key = albumKey(a.title, a.artist);
    return { owned: owned.has(key), job: jobByAlbum.get(key) };
  };
  const openArtist = (a: CatalogArtist) => {
    setAlbum(null);
    setArtist(a);
    setQuery('');
    window.scrollTo({ top: 0 });
  };
  const pickGenre = (id: number | null) => {
    setArtist(null);
    setQuery('');
    setGenre(id);
  };

  return (
    <div ref={top} className="px-[4%] pb-24 pt-[108px]">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <h2 className="text-3xl font-bold">Browse</h2>
          {kindControl}
        </div>
        <button className="nf-btn-ghost relative text-sm" onClick={() => setDownloadsOpen(true)} aria-label={`Music downloads${activeJobs ? `, ${activeJobs} in progress` : ''}`}>
          <SoulseekDot state={status} />
          <Download className="h-4 w-4" />
          Downloads
          {activeJobs > 0 && <span className="ml-1 rounded-full bg-[#ff4560] px-1.5 text-xs font-bold tabular-nums">{activeJobs}</span>}
        </button>
      </div>

      <div className="mb-8 flex flex-wrap items-center gap-4">
        <SearchField
          className="min-w-[260px] flex-1 sm:flex-none"
          inputClassName="w-full sm:w-80 scroll-mt-24"
          ariaLabel="Search albums, artists and songs"
          value={query}
          onChange={(v) => {
            setQuery(v);
            if (v.trim()) setArtist(null);
          }}
          placeholder="Albums, artists, songs"
        />
        {!query.trim() && !artist && (
          <div className="-my-1 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Genres">
            <Chip active={!genre} onClick={() => pickGenre(null)}>
              For you
            </Chip>
            {GENRES.map((g) => (
              <Chip key={g.id} active={genre === g.id} onClick={() => pickGenre(g.id)}>
                {g.label}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {search ? (
        <SearchResults query={search} onAlbum={setAlbum} onArtist={openArtist} tileState={tileState} />
      ) : artist ? (
        <MusicArtistView artist={artist} onBack={() => setArtist(null)} onAlbum={setAlbum} tileState={tileState} />
      ) : genre ? (
        <GenreView genre={genre} onAlbum={setAlbum} tileState={tileState} />
      ) : (
        <Home onAlbum={setAlbum} onArtist={openArtist} onGenre={pickGenre} tileState={tileState} />
      )}

      {album && <MusicAlbumDialog key={album.id} album={album} onClose={() => setAlbum(null)} onArtist={openArtist} active={!downloadsOpen} />}
      {downloadsOpen && <MusicDownloadsDialog onClose={() => setDownloadsOpen(false)} />}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${active ? 'bg-white text-black' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
    >
      {children}
    </button>
  );
}

function ShelfError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 py-6 text-sm text-white/60">
      <AlertCircle className="h-4 w-4 shrink-0 text-nf-red" />
      <span>{message}</span>
      <button className="nf-btn-ghost h-8 px-3 text-xs" onClick={retry}>
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </button>
    </div>
  );
}

/** Mounts its content once it's near the screen, so rows further down load as you get to them. */
function WhenNear({ children, height = 300 }: { children: ReactNode; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: '400px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} style={near ? undefined : { minHeight: height }}>{near && children}</div>;
}

interface ViewProps {
  onAlbum: (album: CatalogAlbum) => void;
  tileState: (album: CatalogAlbum) => TileState;
}

function Home({ onAlbum, onArtist, onGenre, tileState }: ViewProps & { onArtist: (a: CatalogArtist) => void; onGenre: (id: number) => void }) {
  const charts = useCatalogQuery('chart:all', () => chartAlbums());
  const fresh = useCatalogQuery('new-releases', newReleases);
  const artists = useCatalogQuery('top-artists', topArtists);
  const top = charts.data?.[0];
  const featured = [
    top && { album: top, label: 'Number one album' },
    ...(fresh.data ?? []).filter((a) => a.id !== top?.id).slice(0, top ? 2 : 3).map((album) => ({ album, label: 'New release' })),
  ].filter((f): f is { album: CatalogAlbum; label: string } => !!f);

  return (
    <>
      <section className="mb-10 grid gap-4 md:grid-cols-3" aria-label="Featured">
        {featured.length
          ? featured.map((f) => <FeatureCard key={f.album.id + f.label} album={f.album} label={f.label} onOpen={onAlbum} />)
          : Array.from({ length: 3 }, (_, i) => <Bone key={i} className="h-40 rounded-xl" />)}
      </section>

      <Shelf title="Top albums" subtitle={`The most popular albums right now · ${COUNTRY}`} loading={charts.loading}>
        {charts.error ? <ShelfError message={charts.error} retry={charts.retry} /> : charts.data?.slice(0, 40).map((a, i) => <AlbumTile key={a.id} album={a} rank={i < 10 ? i + 1 : undefined} state={tileState(a)} onOpen={onAlbum} className={SHELF_TILE} />)}
      </Shelf>

      <Shelf title="New releases" subtitle="Charting albums and EPs from the last six weeks" loading={fresh.loading} empty={fresh.data && !fresh.data.length ? 'Nothing new is charting right now.' : undefined}>
        {fresh.error ? <ShelfError message={fresh.error} retry={fresh.retry} /> : fresh.data?.slice(0, 30).map((a) => <AlbumTile key={a.id} album={a} state={tileState(a)} onOpen={onAlbum} className={SHELF_TILE} />)}
      </Shelf>

      <Shelf title="Popular artists" subtitle="From this week’s top albums" loading={artists.loading}>
        {artists.error ? <ShelfError message={artists.error} retry={artists.retry} /> : artists.data?.map((a) => <ArtistBubble key={a.id} artist={a} onOpen={onArtist} />)}
      </Shelf>

      {GENRES.slice(0, 8).map((g) => (
        <WhenNear key={g.id}>
          <GenreShelf genre={g.id} label={g.label} onAlbum={onAlbum} onMore={() => onGenre(g.id)} tileState={tileState} />
        </WhenNear>
      ))}
    </>
  );
}

function FeatureCard({ album, label, onOpen }: { album: CatalogAlbum; label: string; onOpen: (a: CatalogAlbum) => void }) {
  return (
    <button type="button" onClick={() => onOpen(album)} className="group relative flex h-40 items-center gap-5 overflow-hidden rounded-xl bg-white/5 p-4 text-left outline-none ring-white/70 focus-visible:ring-2">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <CoverArt url={album.cover} className="h-full w-full scale-150 blur-2xl" rounded="" eager />
      </div>
      <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-black/70" />
      <CoverArt url={album.cover} eager className="relative w-32 shrink-0 shadow-xl transition duration-300 group-hover:scale-[1.03]" />
      <div className="relative min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/70">{label}</p>
        <p className="mt-1 line-clamp-2 text-lg font-bold leading-tight">{album.title}</p>
        <p className="mt-0.5 truncate text-sm text-white/70">{album.artist}</p>
      </div>
    </button>
  );
}

function GenreShelf({ genre, label, onAlbum, onMore, tileState }: ViewProps & { genre: number; label: string; onMore: () => void }) {
  const q = useCatalogQuery(`chart:${genre}`, () => chartAlbums(genre));
  return (
    <Shelf
      title={`Top ${label}`}
      loading={q.loading}
      action={
        <button className="text-sm font-semibold text-white/60 hover:text-white" onClick={onMore}>
          See all
        </button>
      }
    >
      {q.error ? <ShelfError message={q.error} retry={q.retry} /> : q.data?.slice(0, 20).map((a) => <AlbumTile key={a.id} album={a} state={tileState(a)} onOpen={onAlbum} className={SHELF_TILE} />)}
    </Shelf>
  );
}

function GenreView({ genre, onAlbum, tileState }: ViewProps & { genre: number }) {
  const q = useCatalogQuery(`chart:${genre}`, () => chartAlbums(genre));
  const label = GENRES.find((g) => g.id === genre)?.label ?? 'Genre';
  return (
    <section>
      <h3 className="mb-1 text-2xl font-bold tracking-tight">Top {label} albums</h3>
      <p className="mb-6 text-sm text-white/50">The most popular right now · {COUNTRY}</p>
      {q.error ? (
        <ShelfError message={q.error} retry={q.retry} />
      ) : !q.data ? (
        <GridSkeleton />
      ) : q.data.length ? (
        <div className={ALBUM_GRID}>
          {q.data.map((a, i) => (
            <AlbumTile key={a.id} album={a} rank={i < 10 ? i + 1 : undefined} state={tileState(a)} onOpen={onAlbum} />
          ))}
        </div>
      ) : (
        <p className="py-16 text-center text-white/50">Nothing here yet.</p>
      )}
    </section>
  );
}

const clock = (ms: number | null) => {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function SearchResults({ query, onAlbum, onArtist, tileState }: ViewProps & { query: string; onArtist: (a: CatalogArtist) => void }) {
  const albums = useCatalogQuery(`search-albums:${query}`, () => searchAlbums(query));
  const artists = useCatalogQuery(`search-artists:${query}`, () => searchArtists(query));
  const songs = useCatalogQuery(`search-songs:${query}`, () => searchSongs(query));
  const nothing = !albums.loading && !artists.loading && !songs.loading && !albums.data?.length && !artists.data?.length && !songs.data?.length;
  if (nothing && !albums.error && !artists.error && !songs.error)
    return (
      <div className="py-20 text-center text-white/50">
        <Music2 className="mx-auto mb-3 h-10 w-10" />
        No albums, artists or songs match “{query}”.
      </div>
    );
  return (
    <>
      {(artists.loading || !!artists.data?.length) && (
        <Shelf title="Artists" loading={artists.loading}>
          {artists.data?.map((a) => <ArtistBubble key={a.id} artist={a} onOpen={onArtist} />)}
        </Shelf>
      )}
      <section className="mb-10">
        <h3 className="mb-3 text-xl font-bold tracking-tight">Albums</h3>
        {albums.error ? (
          <ShelfError message={albums.error} retry={albums.retry} />
        ) : !albums.data ? (
          <GridSkeleton count={7} />
        ) : albums.data.length ? (
          <div className={ALBUM_GRID}>
            {albums.data.map((a) => (
              <AlbumTile key={a.id} album={a} state={tileState(a)} onOpen={onAlbum} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/45">No albums.</p>
        )}
      </section>
      <section className="mb-10">
        <h3 className="mb-3 text-xl font-bold tracking-tight">Songs</h3>
        {songs.error ? (
          <ShelfError message={songs.error} retry={songs.retry} />
        ) : !songs.data ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Bone key={i} className="h-14 w-full rounded" tone="soft" />
            ))}
          </div>
        ) : songs.data.length ? (
          <ul className="grid gap-x-8 md:grid-cols-2">
            {songs.data.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!s.album}
                  onClick={() => s.album && onAlbum(s.album)}
                  className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-white/[0.06] disabled:cursor-default"
                >
                  <CoverArt url={s.album?.cover ?? null} className="w-11 shrink-0" rounded="rounded" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.title}</span>
                    <span className="block truncate text-xs text-white/50">
                      {s.artist}
                      {s.album ? ` · ${s.album.title}` : ''}
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-white/45">{clock(s.lengthMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/45">No songs.</p>
        )}
      </section>
    </>
  );
}
