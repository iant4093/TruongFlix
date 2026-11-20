import { Heart } from 'lucide-react';
import { formatTime } from '../library';
import { playTracks, toggle, toggleFavourite, useMusicPlayer } from '../player';
import type { MusicTrack } from '../types';
import { musicToast } from '../nav';
import TrackMenu, { openTrackMenuAt, type MenuContext } from './TrackMenu';
import { Cover, EqBars } from './ui';

interface Props {
  tracks: MusicTrack[];
  /** "number" shows track numbers (album pages); "art" shows covers (song lists). */
  lead?: 'number' | 'art';
  showAlbum?: boolean;
  showArtist?: boolean;
  /** Inside a playlist: enables "Remove from Playlist" and drag handles via `onMove`. */
  playlistId?: number;
  onMove?: (from: number, to: number) => void;
  /** The whole list being played when only part of it is shown (long lists load in steps). */
  queueIds?: number[];
}

/** Songs as rows: tap to play the list from that song. */
export default function TrackList({ tracks, lead = 'art', showAlbum = true, showArtist = true, playlistId, onMove, queueIds }: Props) {
  const current = useMusicPlayer((s) => s.track?.id ?? null);
  const playing = useMusicPlayer((s) => s.playing);
  // Tapping a song plays on through the whole list, not just the rows loaded so far (it stopped
  // after song 250 of a big library). The shown rows are the start of `queueIds`.
  const ids = queueIds ?? tracks.map((t) => t.id);
  const multiDisc = lead === 'number' && new Set(tracks.map((t) => t.discNo ?? 1)).size > 1;

  return (
    <div role="list" className="divide-y divide-white/[0.07]">
      {tracks.map((t, i) => {
        const isCurrent = current === t.id;
        const discBreak = multiDisc && (i === 0 || (tracks[i - 1].discNo ?? 1) !== (t.discNo ?? 1));
        const context: MenuContext | undefined = playlistId != null ? { playlistId, position: i } : undefined;
        return (
          // Long lists: rows off screen skip layout and paint until scrolled near (keeps big libraries smooth).
          <div key={`${t.id}-${i}`} role="listitem" className="[contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]">
            {discBreak && <div className="pb-2 pt-5 text-xs font-semibold uppercase tracking-widest text-white/45">Disc {t.discNo ?? 1}</div>}
            <div
              draggable={!!onMove}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/x-tf-index', String(i));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => onMove && e.dataTransfer.types.includes('text/x-tf-index') && e.preventDefault()}
              onDrop={(e) => {
                const from = Number(e.dataTransfer.getData('text/x-tf-index'));
                if (onMove && Number.isFinite(from)) onMove(from, i);
              }}
              onClick={() => (isCurrent ? toggle() : playTracks(ids, i))}
              onContextMenu={(e) => openTrackMenuAt(e, [t], context)}
              className={`tfm-press-row group flex cursor-default items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.06] ${isCurrent ? 'text-[#fa2d48]' : ''}`}
            >
              {lead === 'number' ? (
                <div className="flex w-7 shrink-0 justify-center text-sm tabular-nums text-white/45">
                  {isCurrent ? <EqBars playing={playing} className="text-[#fa2d48]" /> : t.trackNo ?? '–'}
                </div>
              ) : (
                <div className="relative h-11 w-11 shrink-0">
                  <Cover art={t.art} rounded="rounded" />
                  {isCurrent && (
                    <div className="absolute inset-0 flex items-center justify-center rounded bg-black/45">
                      <EqBars playing={playing} className="text-white" />
                    </div>
                  )}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className={`truncate text-[15px] ${isCurrent ? 'font-semibold' : 'text-white'}`}>{t.title}</div>
                {(showArtist || showAlbum) && (
                  <div className="truncate text-[13px] text-white/50">{[showArtist ? t.artist : null, showAlbum ? t.album : null].filter(Boolean).join(' · ')}</div>
                )}
              </div>
              <button
                type="button"
                aria-label={t.favourite ? 'Remove from Favourites' : 'Favourite'}
                title={t.favourite ? 'Remove from Favourites' : 'Favourite'}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleFavourite(t).catch((err) => musicToast(String(err)));
                }}
                className={`hidden h-8 w-8 shrink-0 items-center justify-center rounded-full sm:flex ${t.favourite ? 'text-[#fa2d48]' : 'text-white/40 opacity-0 hover:text-white group-hover:opacity-100'}`}
              >
                <Heart className={`h-4 w-4 ${t.favourite ? 'fill-current' : ''}`} />
              </button>
              {t.favourite && <Heart className="h-3.5 w-3.5 shrink-0 fill-[#fa2d48] text-[#fa2d48] sm:hidden" aria-label="Favourite" />}
              <div className="hidden w-12 shrink-0 text-right text-[13px] tabular-nums text-white/45 sm:block">{formatTime(t.duration)}</div>
              <TrackMenu tracks={[t]} context={context} label={`More options for ${t.title}`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
