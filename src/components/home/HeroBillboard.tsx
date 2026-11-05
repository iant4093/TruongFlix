import { useBannerTrailer, useBannerVisibility } from './useBannerTrailer';
import { BillboardControls, BillboardMedia } from './BannerTrailer';
import BillboardCopy from './BillboardCopy';
import type { MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { playTargetFor } from '../../store/selectors';
import { playItem } from '../../services/player';

export default function HeroBillboard({ item }: { item: MediaItem }) {
  const openDetail = useLibraryStore((s) => s.openDetail);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const target = playTargetFor(item, episodesBySeries);
  const enabled = useLibraryStore((s) => s.settings.trailers_autoplay);
  const playing = useBannerVisibility();
  const trailer = useBannerTrailer(item, enabled, playing);

  return (
    <section className="nf-billboard">
      <BillboardMedia title={item.title} backdrop={item.backdrop} trailer={trailer} />
      <BillboardCopy
        key={item.key}
        item={item}
        trailerActive={trailer.active}
        onInfo={() => openDetail(item.key)}
        play={{ resume: !!target && target.startTime > 0, onClick: () => playItem(item) }}
      />
      <BillboardControls trailer={trailer} certification={item.certification} />
    </section>
  );
}
