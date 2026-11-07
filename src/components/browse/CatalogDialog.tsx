import { useRef } from 'react';
import { X } from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog';

export default function CatalogDialog({ title, onClose, active, children }: {
  title: string; onClose: () => void; active: boolean; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, active, priority: 100 });
  if (!active) return null;
  return <div data-catalog-scroll
    className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-black/80 px-4 pb-10 pt-8 backdrop-blur-sm"
    onMouseDown={onBackdropMouseDown}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
      className="nf-dialog-enter relative mx-auto w-full max-w-4xl rounded-xl bg-nf-surface shadow-2xl outline-none">
      <div data-catalog-close className="pointer-events-none sticky top-0 z-20 flex h-0 items-start justify-end">
        <button aria-label="Close dialog" onClick={onClose} className="pointer-events-auto mr-4 mt-4 flex h-9 w-9 items-center justify-center rounded-full bg-nf-surface text-white hover:bg-[#2a2a2a] focus-visible:ring-2 focus-visible:ring-white"><X className="h-5 w-5" /></button>
      </div>
      {children}
    </div>
  </div>;
}
