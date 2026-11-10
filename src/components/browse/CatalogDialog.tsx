import { useLayoutEffect, useRef, type ReactNode } from 'react';
import Dialog from '../common/Dialog';

export default function CatalogDialog({ title, onClose, active, children }: {
  title: string; onClose: () => void; active: boolean; children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  useLayoutEffect(() => {
    if (active && backdrop.current) backdrop.current.scrollTop = scrollTop.current;
  }, [active]);

  return (
    <Dialog
      label={title}
      onClose={onClose}
      open={active}
      priority={100}
      size="xl"
      align="top"
      chrome="floating"
      backdropRef={backdrop}
      backdropProps={{ 'data-catalog-scroll': true, onScroll: (event) => { scrollTop.current = event.currentTarget.scrollTop; } }}
    >
      {children}
    </Dialog>
  );
}
