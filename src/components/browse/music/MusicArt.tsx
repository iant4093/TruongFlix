import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Music } from 'lucide-react';
import { liveArtwork } from '../../../services/live';
import { artistPhoto, sizedCover, type CatalogAlbum, type CatalogArtist } from '../../../services/musicCatalog';
import type { AlbumJob } from '../../../services/musicDownloads';
import { FadeImage } from '../../common/Artwork';
import { Bone } from '../../common/Skeleton';

const fromAppleCdn = (url: string) => /^https:\/\/[a-z0-9-]+\.mzstatic\.com\//.test(url);

/** Appears once near the screen, so long rows only load what you scroll to. */
function useNear<T extends HTMLElement>(eager: boolean) {
  const ref = useRef<T>(null);
  // Without IntersectionObserver (old web views, tests) everything loads at once.
  const [near, setNear] = useState(eager || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: '300px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near] as const;
}

/**
 * A square cover. Apple's artwork loads straight from its image CDN at the size shown (`px`);
 * anything else goes through the app's artwork cache.
 */
export function CoverArt({ url, alt = '', className = '', eager = false, rounded = 'rounded-md', px = 400 }: { url: string | null; alt?: string; className?: string; eager?: boolean; rounded?: string; px?: number }) {
  const [ref, near] = useNear<HTMLDivElement>(eager);
  const [src, setSrc] = useState('');
  useEffect(() => {
    setSrc('');
    if (!url || !near) return;
    if (fromAppleCdn(url)) {
      setSrc(sizedCover(url, px) ?? '');
      return;
    }
    let alive = true;
    void liveArtwork(url)
      .then((path) => alive && setSrc(path))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url, near, px]);
  return (
    <div ref={ref} className={`relative aspect-square overflow-hidden bg-gradient-to-br from-[#3a3a3c] to-[#1c1c1e] ${rounded} ${className}`}>
      {src ? (
        <FadeImage src={src} alt={alt} eager={eager} className="absolute inset-0 h-full w-full" onError={() => setSrc('')} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-white/25">
          <Music className="h-1/3 w-1/3" strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

/** A soft colour per name, behind an artist's initials while (or when no) photo shows. */
export function nameHue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export const initials = (name: string) =>
  name
    .replace(/^the\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

/** An artist's photo in a circle, or their initials on a colour of their own. */
export function ArtistPortrait({ artist, className = '', px = 300, eager = false }: { artist: CatalogArtist; className?: string; px?: number; eager?: boolean }) {
  const [ref, near] = useNear<HTMLSpanElement>(eager);
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    if (!near) return;
    let alive = true;
    void artistPhoto(artist.id).then((url) => alive && setPhoto(url ? sizedCover(url, px) : null));
    return () => {
      alive = false;
    };
  }, [artist.id, near, px]);
  const hue = nameHue(artist.name);
  return (
    <span
      ref={ref}
      className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-full font-bold text-white/90 ${className}`}
      style={{ background: `radial-gradient(circle at 30% 25%, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 45% 22%))` }}
      aria-hidden
    >
      {initials(artist.name)}
      {photo && <FadeImage src={photo} alt="" className="absolute inset-0 h-full w-full" onError={() => setPhoto(null)} />}
    </span>
  );
}

export function ArtistBubble({ artist, onOpen }: { artist: CatalogArtist; onOpen: (artist: CatalogArtist) => void }) {
  return (
    <button type="button" onClick={() => onOpen(artist)} className="group flex w-32 shrink-0 snap-start flex-col items-center gap-3 text-center outline-none" title={artist.name}>
      <ArtistPortrait artist={artist} className="w-full text-3xl shadow-lg ring-white/70 transition duration-300 group-hover:scale-[1.04] group-focus-visible:ring-2" />
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
      <p className="mt-2 truncate text-sm font-semibold">
        {album.explicit && <span className="mr-1.5 inline-flex h-4 w-4 translate-y-[-1px] items-center justify-center rounded-sm bg-white/25 align-middle text-[10px] font-bold" title="Explicit">E</span>}
        {album.title}
      </p>
      <p className="truncate text-xs text-white/55">
        {album.artist}
        {album.year ? ` · ${album.year}` : ''}
      </p>
    </button>
  );
}

/** A titled row that scrolls sideways, with arrows on hover. */
export function Shelf({ title, subtitle, action, children, loading, empty, round = false }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; loading?: boolean; empty?: string; round?: boolean }) {
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
    <section className="group/shelf mb-8">
      <div className="mb-1 flex items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold tracking-tight">{title}</h3>
          {subtitle && <p className="text-sm text-white/50">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="relative -mx-[4vw]">
        {/* The scroll area reaches the window's edges and pads itself, so covers, circles and
            their hover zoom and shadow are never clipped. */}
        <div
          ref={row}
          onScroll={measure}
          className="flex snap-x gap-5 overflow-x-auto scroll-smooth px-[4vw] pb-4 pt-3 [scroll-padding-inline:4vw] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {loading
            ? Array.from({ length: 8 }, (_, i) =>
                round ? (
                  <div key={i} className="w-32 shrink-0">
                    <Bone className="aspect-square w-full rounded-full" />
                    <Bone className="mx-auto mt-3 h-3 w-2/3" />
                  </div>
                ) : (
                  <div key={i} className="w-40 shrink-0 md:w-44">
                    <Bone className="aspect-square w-full rounded-md" />
                    <Bone className="mt-2 h-3 w-3/4" />
                    <Bone className="mt-1.5 h-3 w-1/2" />
                  </div>
                ),
              )
            : children}
          {!loading && empty && <p className="py-10 text-sm text-white/45">{empty}</p>}
        </div>
        {!edges.start && (
          <button type="button" aria-label="Scroll back" onClick={() => page(-1)} className="absolute left-[calc(4vw-1.25rem)] top-[42%] hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/75 opacity-0 shadow-lg transition group-hover/shelf:opacity-100 md:flex">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {!edges.end && (
          <button type="button" aria-label="Scroll forward" onClick={() => page(1)} className="absolute right-[calc(4vw-1.25rem)] top-[42%] hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/75 opacity-0 shadow-lg transition group-hover/shelf:opacity-100 md:flex">
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
