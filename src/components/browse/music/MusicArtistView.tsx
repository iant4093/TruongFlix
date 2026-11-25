import { useState } from 'react';
import { AlertCircle, ChevronLeft, RefreshCw } from 'lucide-react';
import { artistDetail, type CatalogAlbum, type CatalogArtist } from '../../../services/musicCatalog';
import useCatalogQuery from '../../../hooks/useCatalogQuery';
import SegmentedControl from '../../common/SegmentedControl';
import { Bone } from '../../common/Skeleton';
import { ALBUM_GRID, AlbumTile, GridSkeleton, nameHue, SHELF_TILE, Shelf, type TileState } from './MusicArt';

type Section = 'albums' | 'eps' | 'singles';

/** An artist: their most played albums, then the discography by kind. */
export default function MusicArtistView({ artist, onBack, onAlbum, tileState }: { artist: CatalogArtist; onBack: () => void; onAlbum: (album: CatalogAlbum) => void; tileState: (album: CatalogAlbum) => TileState }) {
  const detail = useCatalogQuery(`artist:${artist.id}`, () => artistDetail(artist));
  const [section, setSection] = useState<Section>('albums');
  const page = detail.data;
  const hue = nameHue(artist.name);
  const sections: { value: Section; label: string }[] = page
    ? ([
        { value: 'albums', label: `Albums (${page.albums.length})` },
        { value: 'eps', label: `EPs (${page.eps.length})` },
        { value: 'singles', label: `Singles (${page.singles.length})` },
      ] as const).filter((s) => page[s.value].length > 0)
    : [];
  const shown = page ? (page[section].length ? page[section] : page[sections[0]?.value ?? 'albums']) : [];
  const facts = page ? [page.artist.type, page.artist.area, page.artist.begin ? `Since ${page.artist.begin.slice(0, 4)}` : null].filter(Boolean).join(' · ') : artist.detail;

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-6 inline-flex items-center gap-1 text-sm font-semibold text-white/70 hover:text-white">
        <ChevronLeft className="h-5 w-5" /> Back
      </button>
      <header className="relative mb-10 flex items-center gap-7 overflow-hidden rounded-2xl p-7" style={{ background: `linear-gradient(120deg, hsl(${hue} 45% 26%), hsl(${(hue + 50) % 360} 35% 12%) 70%)` }}>
        <span className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full bg-black/25 text-4xl font-bold shadow-xl sm:h-36 sm:w-36" aria-hidden>
          {artist.name.replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">Artist</p>
          <h2 className="mt-1 text-4xl font-extrabold tracking-tight sm:text-5xl">{page?.artist.name ?? artist.name}</h2>
          {facts && <p className="mt-2 text-sm text-white/65">{facts}</p>}
          {!!page?.artist.genres.length && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {page.artist.genres.map((g) => (
                <span key={g} className="rounded-full bg-black/25 px-2.5 py-0.5 text-xs capitalize text-white/80">
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

      {detail.error ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/70">
          <AlertCircle className="h-5 w-5 shrink-0 text-nf-red" />
          <span className="flex-1">Couldn’t load this artist: {detail.error}</span>
          <button className="nf-btn-ghost" onClick={detail.retry}>
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : !page ? (
        <div role="status" aria-label="Loading artist">
          <Bone className="mb-4 h-6 w-40" />
          <GridSkeleton count={7} />
        </div>
      ) : (
        <>
          {page.popular.length > 0 && (
            <Shelf title="Popular" subtitle="Their most played albums and EPs">
              {page.popular.map((album) => (
                <AlbumTile key={album.id} album={album} state={tileState(album)} onOpen={onAlbum} className={SHELF_TILE} />
              ))}
            </Shelf>
          )}
          {sections.length > 0 ? (
            <section>
              <div className="mb-4 flex flex-wrap items-center gap-4">
                <h3 className="text-xl font-bold tracking-tight">Discography</h3>
                {sections.length > 1 && <SegmentedControl ariaLabel="Discography" size="sm" value={shown === page[section] ? section : sections[0].value} options={sections} onChange={setSection} />}
              </div>
              <div className={ALBUM_GRID}>
                {shown.map((album) => (
                  <AlbumTile key={album.id} album={album} state={tileState(album)} onOpen={onAlbum} />
                ))}
              </div>
            </section>
          ) : (
            <p className="py-10 text-center text-white/50">MusicBrainz doesn’t list any albums for this artist yet.</p>
          )}
        </>
      )}
    </div>
  );
}
