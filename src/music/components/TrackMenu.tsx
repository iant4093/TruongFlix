import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { ChevronLeft, Disc3, Heart, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { addToPlaylist, createPlaylist, setPlaylistTracks } from '../actions';
import { musicToast, openRoute } from '../nav';
import { addToQueue, playNext, setFull, toggleFavourite, useMusicPlayer } from '../player';
import type { MusicTrack } from '../types';
import { askName } from './Overlays';
import { useDismiss } from './ui';

export interface MenuContext {
  /** Shown inside this playlist: offers "Remove from Playlist" for this position. */
  playlistId?: number;
  position?: number;
}

/** The same menu opened by right-clicking a song (at the pointer). */
const usePointMenu = create<{ at: { x: number; y: number; tracks: MusicTrack[]; context?: MenuContext } | null }>(() => ({ at: null }));

export function openTrackMenuAt(event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, tracks: MusicTrack[], context?: MenuContext) {
  event.preventDefault();
  event.stopPropagation();
  usePointMenu.setState({ at: { x: event.clientX, y: event.clientY, tracks, context } });
}

/** Rendered once by each app (see `MusicOverlays`). */
export function TrackPointMenu() {
  const at = usePointMenu((s) => s.at);
  const close = useCallback(() => usePointMenu.setState({ at: null }), []);
  if (!at) return null;
  return <Menu key={`${at.x}:${at.y}`} anchor={null} point={at} tracks={at.tracks} context={at.context} close={close} />;
}

const ITEM = 'flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none sm:py-2 sm:text-sm';

/** The "…" menu for a song: queue, playlists, favourite, go to album/artist. */
export default function TrackMenu({ tracks, context, className = '', label = 'More', children }: { tracks: MusicTrack[]; context?: MenuContext; className?: string; label?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white ${className}`}
      >
        {children ?? <MoreHorizontal className="h-5 w-5" />}
      </button>
      {open && <Menu anchor={button.current} tracks={tracks} context={context} close={() => setOpen(false)} />}
    </>
  );
}

function Menu({ anchor, point, tracks, context, close }: { anchor: HTMLElement | null; point?: { x: number; y: number }; tracks: MusicTrack[]; context?: MenuContext; close: () => void }) {
  const playlists = useMusicPlayer((s) => s.library?.playlists ?? []);
  const byId = useMusicPlayer((s) => s.byId);
  const [page, setPage] = useState<'main' | 'playlists'>('main');
  const stableClose = useCallback(close, [close]);
  const ref = useDismiss(true, stableClose, anchor);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const sheet = typeof window !== 'undefined' && window.innerWidth < 640;
  const ids = tracks.map((t) => t.id);
  const single = tracks.length === 1 ? byId.get(tracks[0].id) ?? tracks[0] : null;

  useLayoutEffect(() => {
    if (sheet || (!anchor && !point) || !ref.current) return;
    const h = ref.current.offsetHeight;
    const w = ref.current.offsetWidth;
    if (point) {
      const top = point.y + h > window.innerHeight - 8 ? Math.max(8, point.y - h) : point.y;
      const left = point.x + w > window.innerWidth - 8 ? Math.max(8, point.x - w) : point.x;
      return setPos({ top, left });
    }
    const r = anchor!.getBoundingClientRect();
    const top = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    setPos({ top, left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) });
  }, [anchor, point, sheet, page, ref]);

  const run = (fn: () => void | Promise<unknown>) => () => {
    close();
    void Promise.resolve()
      .then(fn)
      .catch((e) => musicToast(e instanceof Error ? e.message : String(e)));
  };
  const go = (route: Parameters<typeof openRoute>[0]) => run(() => {
    setFull(false);
    openRoute(route);
  });
  const count = tracks.length === 1 ? 'song' : `${tracks.length} songs`;

  const body =
    page === 'main' ? (
      <>
        {single && (
          <div className="flex items-center gap-3 border-b border-white/10 px-4 pb-3 pt-1 sm:hidden">
            <div className="min-w-0">
              <div className="truncate font-semibold">{single.title}</div>
              <div className="truncate text-sm text-white/55">{single.artist}</div>
            </div>
          </div>
        )}
        <button role="menuitem" className={ITEM} onClick={run(() => { playNext(ids); musicToast(tracks.length === 1 ? 'Playing next' : `${tracks.length} songs playing next`); })}>
          <ListStart className="h-4 w-4" /> Play Next
        </button>
        <button role="menuitem" className={ITEM} onClick={run(() => { addToQueue(ids); musicToast(tracks.length === 1 ? 'Added to queue' : `${tracks.length} songs added to queue`); })}>
          <ListEnd className="h-4 w-4" /> Add to Queue
        </button>
        <button role="menuitem" className={ITEM} onClick={(e) => { e.stopPropagation(); setPage('playlists'); }}>
          <ListPlus className="h-4 w-4" /> Add to Playlist…
        </button>
        {context?.playlistId != null && context.position != null && (
          <button
            role="menuitem"
            className={`${ITEM} text-[#ff6b7d]`}
            onClick={run(async () => {
              const pl = playlists.find((p) => p.id === context.playlistId);
              if (!pl) return;
              await setPlaylistTracks(pl.id, pl.trackIds.filter((_, i) => i !== context.position));
              musicToast('Removed from playlist');
            })}
          >
            <Trash2 className="h-4 w-4" /> Remove from Playlist
          </button>
        )}
        {single && (
          <>
            <div className="my-1 border-t border-white/10" />
            <button role="menuitem" className={ITEM} onClick={run(() => toggleFavourite(single))}>
              <Heart className={`h-4 w-4 ${single.favourite ? 'fill-[#fa2d48] text-[#fa2d48]' : ''}`} /> {single.favourite ? 'Remove from Favourites' : 'Favourite'}
            </button>
            <button role="menuitem" className={ITEM} onClick={go({ page: 'album', id: single.albumId })}>
              <Disc3 className="h-4 w-4" /> Go to Album
            </button>
            <button role="menuitem" className={ITEM} onClick={go({ page: 'artist', id: single.albumArtistId === single.artistId ? single.albumArtistId : single.artistId })}>
              <MicVocal className="h-4 w-4" /> Go to Artist
            </button>
          </>
        )}
      </>
    ) : (
      <>
        <button className={`${ITEM} font-semibold`} onClick={(e) => { e.stopPropagation(); setPage('main'); }}>
          <ChevronLeft className="h-4 w-4" /> Add {count} to…
        </button>
        <div className="my-1 border-t border-white/10" />
        <button
          role="menuitem"
          className={ITEM}
          onClick={run(async () => {
            const name = await askName('New Playlist', '', 'Create');
            if (!name) return;
            await createPlaylist(name, ids);
            musicToast(`Added to “${name}”`);
          })}
        >
          <Plus className="h-4 w-4" /> New Playlist…
        </button>
        <div className="max-h-64 overflow-y-auto">
          {playlists.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              className={ITEM}
              onClick={run(async () => {
                await addToPlaylist(p.id, ids);
                musicToast(`Added to “${p.name}”`);
              })}
            >
              <ListMusic className="h-4 w-4" /> <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
      </>
    );

  return createPortal(
    sheet ? (
      <div className="nf-fade fixed inset-0 z-[250] bg-black/50" onClick={(e) => e.stopPropagation()}>
        <div ref={ref} role="menu" className="nf-sheet-up absolute inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] overflow-hidden rounded-2xl border border-white/10 bg-[#2c2c2e]/95 py-2 shadow-2xl backdrop-blur-xl">
          {body}
          <div className="mt-1 border-t border-white/10 px-2 pt-2">
            <button onClick={close} className="h-11 w-full rounded-xl text-[15px] font-semibold text-white/80 active:bg-white/10">
              Cancel
            </button>
          </div>
        </div>
      </div>
    ) : (
      <div
        ref={ref}
        role="menu"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        className="nf-pop-in fixed z-[250] w-60 overflow-hidden rounded-xl border border-white/10 bg-[#2c2c2e]/95 py-1.5 shadow-2xl backdrop-blur-xl"
        style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      >
        {body}
      </div>
    ),
    document.body,
  );
}
