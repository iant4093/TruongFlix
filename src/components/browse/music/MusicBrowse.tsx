import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ChevronLeft, Download, Music2, RefreshCw } from 'lucide-react';
import { useSectionState } from '../../../lib/sectionMemory';
import { loadMusicLibrary } from '../../../music/actions';
import { useMusicPlayer } from '../../../music/player';
import {
  albumKey,
  artistsFrom,
  chartCountry,
  chartPool,
  GENRES,
  genresIn,
  inGenre,
  recentFrom,
  searchMusic,
  topAlbums,
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
 * Browse → Music: what people are streaming, genres, search, artists and albums, built like a
 * streaming service's browse page (square covers, rows that scroll sideways) rather than the
 * movie posters. Albums open a page with their tracklist and a Download button.
 */
export default function MusicBrowse({ kindControl }: { kindControl: ReactNode }) {
  const [query, setQuery] = useSectionState('music:query', '');
  const [genre, setGenre] = useSectionState<string | null>('music:genre', null);
  const [artist, setArtist] = useSectionState<CatalogArtist | null>('music:artist', null);
  const [album, setAlbum] = useState<CatalogAlbum | null>(null);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const search = useDebounced(query.trim(), 400);
  const library = useMusicPlayer((s) => s.library);
  const jobs = useMusicDownloads((s) => s.jobs);
  const status = useMusicDownloads((s) => s.status.state);
  const activeJobs = Object.values(jobs).filter(isActive).length;
  // One pool of what's most played feeds new releases, artists and every genre.
  const pool = useCatalogQuery('chart-pool', chartPool);
  const genres = useMemo(() => (pool.data ? genresIn(pool.data) : []), [pool.data]);

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
  const goHome = () => {
    setQuery('');
    setArtist(null);
    setGenre(null);
    window.scrollTo({ top: 0 });
  };
  const pickGenre = (key: string | null) => {
    setArtist(null);
    setQuery('');
    setGenre(key);
  };
  const searching = !!query.trim();

  return (
    <div className="px-[4%] pb-24 pt-[108px]">
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

      <div className="mb-6 flex flex-wrap items-center gap-4">
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
        {searching || artist ? (
          <button type="button" onClick={goHome} className="inline-flex items-center gap-1 rounded-full bg-white/10 py-1.5 pl-2 pr-4 text-sm font-semibold hover:bg-white/15">
            <ChevronLeft className="h-4 w-4" /> Back to Music
          </button>
        ) : (
          <div className="-my-1 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Genres">
            <Chip active={!genre} onClick={() => pickGenre(null)}>
              For you
            </Chip>
            {genres.map((g) => (
              <Chip key={g.key} active={genre === g.key} onClick={() => pickGenre(g.key)}>
                {g.label}
              </Chip>
            ))}
            {!pool.data && !pool.error && Array.from({ length: 6 }, (_, i) => <Bone key={i} className="h-8 w-20 shrink-0 rounded-full" tone="soft" />)}
          </div>
        )}
      </div>

      {search ? (
        <SearchResults query={search} onAlbum={setAlbum} onArtist={openArtist} tileState={tileState} />
      ) : artist ? (
        <MusicArtistView artist={artist} onAlbum={setAlbum} tileState={tileState} />
      ) : genre ? (
        <GenreView genre={genre} pool={pool} onAlbum={setAlbum} tileState={tileState} />
      ) : (
        <Home pool={pool} genres={genres} onAlbum={setAlbum} onArtist={openArtist} onGenre={pickGenre} tileState={tileState} />
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

interface ViewProps {
  onAlbum: (album: CatalogAlbum) => void;
  tileState: (album: CatalogAlbum) => TileState;
}

type Pool = ReturnType<typeof useCatalogQuery<CatalogAlbum[]>>;

function Home({ pool, genres, onAlbum, onArtist, onGenre, tileState }: ViewProps & { pool: Pool; genres: typeof GENRES; onArtist: (a: CatalogArtist) => void; onGenre: (key: string) => void }) {
  const charts = useCatalogQuery('top-albums', topAlbums);
  const fresh = useMemo(() => (pool.data ? recentFrom(pool.data) : null), [pool.data]);
  const artists = useMemo(() => (pool.data ? artistsFrom(pool.data).slice(0, 24) : null), [pool.data]);
  const top = charts.data?.[0];
  const featured = [
    top && { album: top, label: 'Most played album' },
    ...(fresh ?? []).filter((a) => a.id !== top?.id).slice(0, top ? 2 : 3).map((album) => ({ album, label: 'New release' })),
  ].filter((f): f is { album: CatalogAlbum; label: string } => !!f);

  return (
    <>
      <section className="mb-8 grid gap-4 md:grid-cols-3" aria-label="Featured">
        {featured.length >= 3 || (featured.length && pool.error)
          ? featured.map((f) => <FeatureCard key={f.album.id + f.label} album={f.album} label={f.label} onOpen={onAlbum} />)
          : Array.from({ length: 3 }, (_, i) => <Bone key={i} className="h-40 rounded-xl" />)}
      </section>

      <Shelf title="Top albums" subtitle={`Most played on Apple Music right now · ${COUNTRY}`} loading={charts.loading}>
        {charts.error ? <ShelfError message={charts.error} retry={charts.retry} /> : charts.data?.slice(0, 50).map((a, i) => <AlbumTile key={a.id} album={a} rank={i < 10 ? i + 1 : undefined} state={tileState(a)} onOpen={onAlbum} className={SHELF_TILE} />)}
      </Shelf>

      <Shelf title="New releases" subtitle="Albums and EPs out in the last six weeks that people are playing" loading={!fresh && !pool.error} empty={fresh && !fresh.length ? 'Nothing new is charting right now.' : undefined}>
        {pool.error ? <ShelfError message={pool.error} retry={pool.retry} /> : fresh?.slice(0, 30).map((a) => <AlbumTile key={a.id} album={a} state={tileState(a)} onOpen={onAlbum} className={SHELF_TILE} />)}
      </Shelf>

      <Shelf title="Popular artists" subtitle="Behind the most played music" loading={!artists && !pool.error} round>
        {artists?.map((a) => <ArtistBubble key={a.id} artist={a} onOpen={onArtist} />)}
      </Shelf>

      {pool.data &&
        genres.map((g) => (
          <Shelf
            key={g.key}
            title={g.label}
            action={
              <button className="text-sm font-semibold text-white/60 hover:text-white" onClick={() => onGenre(g.key)}>
                See all
              </button>
            }
          >
            {pool.data!.filter((a) => inGenre(a, g.key)).slice(0, 20).map((a) => <AlbumTile key={a.id} album={a} state={tileState(a)} onOpen={onAlbum} className={SHELF_TILE} />)}
          </Shelf>
        ))}
    </>
  );
}

function FeatureCard({ album, label, onOpen }: { album: CatalogAlbum; label: string; onOpen: (a: CatalogAlbum) => void }) {
  return (
    <button type="button" onClick={() => onOpen(album)} className="group relative flex h-40 items-center gap-5 overflow-hidden rounded-xl bg-white/5 p-4 text-left outline-none ring-white/70 focus-visible:ring-2">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <CoverArt url={album.cover} px={100} className="h-full w-full scale-150 blur-2xl" rounded="" eager />
      </div>
      <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-black/70" />
      <CoverArt url={album.cover} px={300} eager className="relative w-32 shrink-0 shadow-xl transition duration-300 group-hover:scale-[1.03]" />
      <div className="relative min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/70">{label}</p>
        <p className="mt-1 line-clamp-2 text-lg font-bold leading-tight">{album.title}</p>
        <p className="mt-0.5 truncate text-sm text-white/70">{album.artist}</p>
      </div>
    </button>
  );
}

function GenreView({ genre, pool, onAlbum, tileState }: ViewProps & { genre: string; pool: Pool }) {
  const label = GENRES.find((g) => g.key === genre)?.label ?? 'Genre';
  const albums = pool.data?.filter((a) => inGenre(a, genre));
  return (
    <section>
      <h3 className="mb-1 text-2xl font-bold tracking-tight">{label}</h3>
      <p className="mb-6 text-sm text-white/50">The most played {label === 'Holiday' ? 'holiday music' : `${label} albums`} right now</p>
      {pool.error ? (
        <ShelfError message={pool.error} retry={pool.retry} />
      ) : !albums ? (
        <GridSkeleton />
      ) : albums.length ? (
        <div className={ALBUM_GRID}>
          {albums.map((a) => (
            <AlbumTile key={a.id} album={a} state={tileState(a)} onOpen={onAlbum} />
          ))}
        </div>
      ) : (
        <p className="py-16 text-center text-white/50">Nothing here right now.</p>
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
  const results = useCatalogQuery(`search:${query.toLowerCase()}`, () => searchMusic(query));
  const top = useRef<HTMLDivElement>(null);
  if (results.error) return <ShelfError message={`Search didn’t work: ${results.error}`} retry={results.retry} />;
  const data = results.data;
  if (data && !data.albums.length && !data.artists.length && !data.songs.length)
    return (
      <div className="py-20 text-center text-white/50">
        <Music2 className="mx-auto mb-3 h-10 w-10" />
        No albums, artists or songs match “{query}”.
      </div>
    );
  return (
    <div ref={top}>
      {(!data || data.artists.length > 0) && (
        <Shelf title="Artists" loading={!data} round>
          {data?.artists.map((a) => <ArtistBubble key={a.id} artist={a} onOpen={onArtist} />)}
        </Shelf>
      )}
      <section className="mb-10">
        <h3 className="mb-3 text-xl font-bold tracking-tight">Albums</h3>
        {!data ? (
          <GridSkeleton count={7} />
        ) : data.albums.length ? (
          <div className={ALBUM_GRID}>
            {data.albums.map((a) => (
              <AlbumTile key={a.id} album={a} state={tileState(a)} onOpen={onAlbum} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/45">No albums.</p>
        )}
      </section>
      <section className="mb-10">
        <h3 className="mb-3 text-xl font-bold tracking-tight">Songs</h3>
        {!data ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Bone key={i} className="h-14 w-full rounded" tone="soft" />
            ))}
          </div>
        ) : data.songs.length ? (
          <ul className="grid gap-x-8 md:grid-cols-2">
            {data.songs.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!s.album}
                  onClick={() => s.album && onAlbum(s.album)}
                  className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-white/[0.06] disabled:cursor-default"
                >
                  <CoverArt url={s.album?.cover ?? null} px={100} className="w-11 shrink-0" rounded="rounded" />
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
    </div>
  );
}
