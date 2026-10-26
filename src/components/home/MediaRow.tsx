import { useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ContinueEntry, MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import MediaCard from './MediaCard';

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
  useEffect(() => {
    const onResize = () => setN(calc());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return n;
}

interface SliderProps {
  title: string;
  count: number;
  perPage: number;
  renderItem: (index: number) => ReactNode;
  itemKey: (index: number) => string;
}

/** Netflix carousel: page-at-a-time sliding with hover chevrons and page indicators. */
export function Slider({ title, count, perPage, renderItem, itemKey }: SliderProps) {
  const [start, setStart] = useState(0);
  const setHover = useLibraryStore((s) => s.setHover);
  const pages = Math.max(1, Math.ceil(count / perPage));
  const maxStart = Math.max(0, count - perPage);
  const page = start >= maxStart && count > perPage ? pages - 1 : Math.floor(start / perPage);

  useEffect(() => {
    if (start > maxStart) setStart(maxStart);
  }, [start, maxStart]);

  const go = (dir: 1 | -1) => {
    setHover(null);
    setStart((s) => (dir > 0 ? Math.min(s + perPage, maxStart) : Math.max(s - perPage, 0)));
  };

  return (
    <section className="group/row relative my-[3vw] first:mt-0">
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
        <div className="overflow-hidden px-[4%]">
          <div
            className="flex transition-transform duration-[750ms] ease-[cubic-bezier(0.5,0,0.1,1)]"
            style={{ transform: `translate3d(${-(start / perPage) * 100}%,0,0)` }}
          >
            {Array.from({ length: count }, (_, i) => (
              <div key={itemKey(i)} className="shrink-0 px-[0.2vw]" style={{ width: `${100 / perPage}%` }}>
                {renderItem(i)}
              </div>
            ))}
          </div>
        </div>

        {start > 0 && (
          <button
            onClick={() => go(-1)}
            aria-label="Previous"
            className="group/chev absolute bottom-0 left-0 top-0 z-20 flex w-[4%] items-center justify-center rounded-r bg-[rgba(20,20,20,0.5)] opacity-0 transition-opacity hover:bg-[rgba(20,20,20,0.7)] group-hover/row:opacity-100"
          >
            <ChevronLeft className="h-9 w-9 transition-transform group-hover/chev:scale-125" />
          </button>
        )}
        {start < maxStart && (
          <button
            onClick={() => go(1)}
            aria-label="Next"
            className="group/chev absolute bottom-0 right-0 top-0 z-20 flex w-[4%] items-center justify-center rounded-l bg-[rgba(20,20,20,0.5)] opacity-0 transition-opacity hover:bg-[rgba(20,20,20,0.7)] group-hover/row:opacity-100"
          >
            <ChevronRight className="h-9 w-9 transition-transform group-hover/chev:scale-125" />
          </button>
        )}
      </div>
    </section>
  );
}

export interface RowEntry {
  item: MediaItem;
  entry?: ContinueEntry;
}

interface Props {
  title: string;
  entries: RowEntry[];
}

export default function MediaRow({ title, entries }: Props) {
  const perPage = useItemsPerRow();
  if (!entries.length) return null;
  return (
    <Slider
      title={title}
      count={entries.length}
      perPage={perPage}
      itemKey={(i) => entries[i].item.key}
      renderItem={(i) => <MediaCard item={entries[i].item} entry={entries[i].entry} />}
    />
  );
}
