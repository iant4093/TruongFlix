import { useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { artistDetail, type CatalogAlbum, type CatalogArtist } from '../../../services/musicCatalog';
import useCatalogQuery from '../../../hooks/useCatalogQuery';
import SegmentedControl from '../../common/SegmentedControl';
import { Bone } from '../../common/Skeleton';
import { ALBUM_GRID, AlbumTile, ArtistPortrait, GridSkeleton, nameHue, SHELF_TILE, Shelf, type TileState } from './MusicArt';

type Section = 'albums' | 'eps' | 'singles';

/** An artist: their photo, most popular albums, then the discography by kind. */
export default function MusicArtistView({ artist, onAlbum, tileState }: { artist: CatalogArtist; onAlbum: (album: CatalogAlbum) => void; tileState: (album: CatalogAlbum) => TileState }) {
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
  const current = sections.some((s) => s.value === section) ? section : sections[0]?.value ?? 'albums';
  const genre = page?.artist.genre ?? artist.detail;

  return (
    <div>
      <header className="relative mb-8 flex items-center gap-7 overflow-hidden rounded-2xl p-7" style={{ background: `linear-gradient(120deg, hsl(${hue} 40% 24%), hsl(${(hue + 50) % 360} 30% 11%) 70%)` }}>
        <ArtistPortrait artist={artist} eager px={400} className="w-32 shrink-0 text-4xl shadow-2xl sm:w-40" />
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">Artist</p>
          <h2 className="mt-1 text-4xl font-extrabold tracking-tight sm:text-5xl">{page?.artist.name ?? artist.name}</h2>
          {genre && <p className="mt-2 text-sm text-white/65">{genre}</p>}
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
            <Shelf title="Popular" subtitle="Their best-known albums and EPs">
              {page.popular.map((album) => (
                <AlbumTile key={album.id} album={album} state={tileState(album)} onOpen={onAlbum} className={SHELF_TILE} />
              ))}
            </Shelf>
          )}
          {sections.length > 0 ? (
            <section>
              <div className="mb-4 flex flex-wrap items-center gap-4">
                <h3 className="text-xl font-bold tracking-tight">Discography</h3>
                {sections.length > 1 && <SegmentedControl ariaLabel="Discography" size="sm" value={current} options={sections} onChange={setSection} />}
              </div>
              <div className={ALBUM_GRID}>
                {page[current].map((album) => (
                  <AlbumTile key={album.id} album={album} state={tileState(album)} onOpen={onAlbum} />
                ))}
              </div>
            </section>
          ) : (
            <p className="py-10 text-center text-white/50">No albums from this artist in the store.</p>
          )}
        </>
      )}
    </div>
  );
}
