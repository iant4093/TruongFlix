import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ContinueEntry, MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import MediaCard from './MediaCard';
import { useSectionState } from '../../lib/sectionMemory';
import { useTvActive } from '../../lib/tvMode';
import { EDGE_EVENT, type EdgeEventDetail } from '../../lib/spatialNav';

export function useItemsPerRow() {
  const calc = () => {
    const w = window.innerWidth;
    if (w >= 1400) return 6;
    if (w >= 1100) return 5;
    if (w >= 800) return 4;
    if (w >= 500) return 3;
    return 2;
  };
  const [n, setN] = useState(calc);
  // TV mode: one card fewer per row, so each is bigger from across the room.
  const tv = useTvActive();
  useEffect(() => {
    const onResize = () => setN(calc());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return tv ? Math.max(2, n - 1) : n;
}

interface SliderProps {
  title: string;
  count: number;
  perPage: number;
  renderItem: (index: number) => ReactNode;
  itemKey: (index: number) => string;
}

/** Netflix carousel: page-at-a-time sliding with hover chevrons and page indicators. */
export const Slider = memo(function Slider({ title, count, perPage, renderItem, itemKey }: SliderProps) {
  // Each row keeps its page when you leave the section and come back.
  const [start, setStart] = useSectionState(`row:${title}`, 0);
  const track = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  /** Card to focus once the page has moved (keyboard paging), or null. */
  const focusIndex = useRef<number | null>(null);
  const setHover = useLibraryStore((s) => s.setHover);
  const pages = Math.max(1, Math.ceil(count / perPage));
  const maxStart = Math.max(0, count - perPage);
  const page = start >= maxStart && count > perPage ? pages - 1 : Math.floor(start / perPage);

  useEffect(() => {
    if (start > maxStart) setStart(maxStart);
  }, [start, maxStart]);

  useLayoutEffect(() => {
    const index = focusIndex.current;
    if (index == null) return;
    focusIndex.current = null;
    track.current?.children[index]?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [start]);

  const go = (dir: 1 | -1, focus: number | null) => {
    setHover(null);
    focusIndex.current = focus;
    setStart((s) => (dir > 0 ? Math.min(s + perPage, maxStart) : Math.max(s - perPage, 0)));
  };
  const goRef = useRef(go);
  goRef.current = go;
  const startRef = useRef(start);
  startRef.current = start;

  // TV mode: moving past the first/last visible card pages the row and focuses the next card.
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const onEdge = (event: Event) => {
      const { direction } = (event as CustomEvent<EdgeEventDetail>).detail;
      const s = startRef.current;
      if (direction === 'right' && s < maxStart) {
        event.preventDefault();
        goRef.current(1, s + perPage);
      } else if (direction === 'left' && s > 0) {
        event.preventDefault();
        goRef.current(-1, s - 1);
      }
    };
    el.addEventListener(EDGE_EVENT, onEdge);
    return () => el.removeEventListener(EDGE_EVENT, onEdge);
  }, [maxStart, perPage]);

  return (
    <section ref={section} data-nav-row="" className="group/row relative my-[3vw] first:mt-0">
      <div className="mb-2 flex items-end justify-between px-[4%]">
        <h2 className="nf-row-title">{title}</h2>
        {pages > 1 && (
          <div className="flex gap-[2px] opacity-0 transition-opacity duration-300 group-hover/row:opacity-100">
            {Array.from({ length: pages }, (_, i) => (
              <span key={i} className={`h-[2px] w-3 ${i === page ? 'bg-[#aaa]' : 'bg-[#4d4d4d]'}`} />
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        {/* Vertical padding (cancelled by the margin) leaves room for the TV focus ring. */}
        <div className="-my-2 overflow-hidden px-[4%] py-2">
          <div
            ref={track}
            className="flex transition-transform duration-[750ms] ease-[cubic-bezier(0.5,0,0.1,1)] motion-reduce:transition-none"
            style={{ transform: `translate3d(${-(start / perPage) * 100}%,0,0)` }}
          >
            {Array.from({ length: count }, (_, i) => (
              <div key={itemKey(i)} {...(i < start || i >= start + perPage ? { inert: '' } : {})} className="shrink-0 px-[0.2vw]" style={{ width: `${100 / perPage}%` }}>
                {/* Only the visible page and its neighbours mount; off-screen slots stay empty. */}
                {i >= start - perPage && i < start + perPage * 2 ? renderItem(i) : null}
              </div>
            ))}
          </div>
        </div>

        {start > 0 && (
          <button
            onClick={(event) => go(-1, event.detail === 0 ? Math.max(start - perPage, 0) : null)}
            aria-label="Previous"
            data-nav-skip=""
            className="group/chev absolute bottom-0 left-0 top-0 z-20 flex w-[4%] items-center justify-center rounded-r bg-[rgba(20,20,20,0.5)] opacity-0 transition-opacity hover:bg-[rgba(20,20,20,0.7)] focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <ChevronLeft className="h-9 w-9 transition-transform group-hover/chev:scale-125" />
          </button>
        )}
        {start < maxStart && (
          <button
            onClick={(event) => go(1, event.detail === 0 ? Math.min(start + perPage, maxStart) : null)}
            aria-label="Next"
            data-nav-skip=""
            className="group/chev absolute bottom-0 right-0 top-0 z-20 flex w-[4%] items-center justify-center rounded-l bg-[rgba(20,20,20,0.5)] opacity-0 transition-opacity hover:bg-[rgba(20,20,20,0.7)] focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <ChevronRight className="h-9 w-9 transition-transform group-hover/chev:scale-125" />
          </button>
        )}
      </div>
    </section>
  );
});

export interface RowEntry {
  item: MediaItem;
  entry?: ContinueEntry;
}

interface Props {
  title: string;
  entries: RowEntry[];
}

export default memo(function MediaRow({ title, entries }: Props) {
  const perPage = useItemsPerRow();
  const itemKey = useCallback((i: number) => entries[i].item.key, [entries]);
  const renderItem = useCallback((i: number) => <MediaCard item={entries[i].item} entry={entries[i].entry} />, [entries]);
  if (!entries.length) return null;
  return <Slider title={title} count={entries.length} perPage={perPage} itemKey={itemKey} renderItem={renderItem} />;
});
