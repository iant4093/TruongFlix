import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Music } from 'lucide-react';
import { liveArtwork } from '../../../services/live';
import type { CatalogAlbum, CatalogArtist } from '../../../services/musicCatalog';
import type { AlbumJob } from '../../../services/musicDownloads';
import { FadeImage } from '../../common/Artwork';
import { Bone } from '../../common/Skeleton';

/** A square cover from the Cover Art Archive, fetched (and cached) once it scrolls into view. */
export function CoverArt({ url, alt = '', className = '', eager = false, rounded = 'rounded-md' }: { url: string | null; alt?: string; className?: string; eager?: boolean; rounded?: string }) {
  const [src, setSrc] = useState('');
  const [visible, setVisible] = useState(eager);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (eager || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [eager]);
  useEffect(() => {
    setSrc('');
    if (!url || !visible) return;
    let alive = true;
    void liveArtwork(url)
      .then((path) => alive && setSrc(path))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url, visible]);
  return (
    <div ref={ref} className={`relative aspect-square overflow-hidden bg-gradient-to-br from-[#3a3a3c] to-[#1c1c1e] ${rounded} ${className}`}>
      {src ? (
        <FadeImage src={src} alt={alt} eager className="absolute inset-0 h-full w-full" onError={() => setSrc('')} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-white/25">
          <Music className="h-1/3 w-1/3" strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

/** A soft colour per name, for artists (MusicBrainz has no artist photos). */
export function nameHue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function ArtistBubble({ artist, onOpen, size = 'md' }: { artist: CatalogArtist; onOpen: (artist: CatalogArtist) => void; size?: 'md' | 'lg' }) {
  const hue = nameHue(artist.name);
  const initials = artist.name.replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
  const dim = size === 'lg' ? 'w-40' : 'w-32';
  return (
    <button type="button" onClick={() => onOpen(artist)} className={`group flex ${dim} shrink-0 flex-col items-center gap-3 text-center outline-none`} title={artist.name}>
      <span
        className="flex aspect-square w-full items-center justify-center rounded-full text-3xl font-bold text-white/90 shadow-lg ring-white/70 transition group-hover:scale-[1.04] group-focus-visible:ring-2"
        style={{ background: `radial-gradient(circle at 30% 25%, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 45% 22%))` }}
        aria-hidden
      >
        {initials}
      </span>
      <span className="line-clamp-2 text-sm font-semibold leading-tight">{artist.name}</span>
    </button>
  );
}

export interface TileState {
  owned: boolean;
  job?: AlbumJob;
}

/** An album: square cover, title and artist, with "in your library" and download progress. */
export function AlbumTile({ album, state, onOpen, rank, className = '' }: { album: CatalogAlbum; state?: TileState; onOpen: (album: CatalogAlbum) => void; rank?: number; className?: string }) {
  const job = state?.job;
  const busy = !!job && !['done', 'failed', 'cancelled'].includes(job.state);
  const progress = job && job.total > 0 ? Math.min(1, job.bytes / job.total) : 0;
  return (
    <button type="button" onClick={() => onOpen(album)} className={`group block min-w-0 text-left outline-none ${className}`} title={`${album.title} · ${album.artist}`}>
      <div className="relative">
        <CoverArt url={album.cover} className="shadow-[0_8px_24px_rgba(0,0,0,0.45)] ring-white/80 transition duration-300 group-hover:brightness-110 group-focus-visible:ring-2" />
        {rank != null && <span className="absolute bottom-1.5 left-2 text-4xl font-black leading-none text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.85)]">{rank}</span>}
        {state?.owned ? (
          <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-emerald-300" title="In your library">
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
            <span className="sr-only">In your library</span>
          </span>
        ) : busy ? (
          <span className="absolute right-1.5 top-1.5 flex h-6 items-center gap-1 rounded-full bg-black/75 px-2 text-[11px] font-semibold" title="Downloading">
            <Download className="h-3 w-3" />
            {job.state === 'downloading' ? `${Math.round(progress * 100)}%` : '…'}
          </span>
        ) : null}
      </div>
      <p className="mt-2 truncate text-sm font-semibold">{album.title}</p>
      <p className="truncate text-xs text-white/55">
        {album.artist}
        {album.year ? ` · ${album.year}` : ''}
      </p>
    </button>
  );
}

/** A titled row that scrolls sideways, with arrows on hover. */
export function Shelf({ title, subtitle, action, children, loading, empty }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; loading?: boolean; empty?: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = row.current;
    if (!el) return;
    const next = { start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 };
    // Only a real change re-renders (this runs after every render).
    setEdges((old) => (old.start === next.start && old.end === next.end ? old : next));
  };
  useEffect(measure);
  const page = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <section className="group/shelf mb-10">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold tracking-tight">{title}</h3>
          {subtitle && <p className="text-sm text-white/50">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="relative -mx-[4vw] px-[4vw]">
        <div ref={row} onScroll={measure} className="flex snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden gap-5 overflow-x-auto scroll-smooth pb-2 [scroll-padding-inline:4vw]">
          {loading
            ? Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="w-40 shrink-0 md:w-44">
                  <Bone className="aspect-square w-full rounded-md" />
                  <Bone className="mt-2 h-3 w-3/4" />
                  <Bone className="mt-1.5 h-3 w-1/2" />
                </div>
              ))
            : children}
          {!loading && empty && <p className="py-10 text-sm text-white/45">{empty}</p>}
        </div>
        {!edges.start && (
          <button type="button" aria-label="Scroll back" onClick={() => page(-1)} className="absolute left-1 top-[38%] hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/75 opacity-0 shadow-lg transition group-hover/shelf:opacity-100 md:flex">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {!edges.end && (
          <button type="button" aria-label="Scroll forward" onClick={() => page(1)} className="absolute right-1 top-[38%] hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/75 opacity-0 shadow-lg transition group-hover/shelf:opacity-100 md:flex">
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </section>
  );
}

export const SHELF_TILE = 'w-40 shrink-0 snap-start md:w-44';
export const ALBUM_GRID = 'grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7';

export function GridSkeleton({ count = 14 }: { count?: number }) {
  return (
    <div className={ALBUM_GRID} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <Bone className="aspect-square w-full rounded-md" />
          <Bone className="mt-2 h-3 w-3/4" />
          <Bone className="mt-1.5 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
