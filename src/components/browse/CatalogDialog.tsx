import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export default function CatalogDialog({ title, onClose, active, children }: {
  title: string; onClose: () => void; active: boolean; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const old = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab') return;
      const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,[tabindex="0"]') ?? [])];
      if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0]?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.documentElement.style.overflow = old; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [active]);
  if (!active) return null;
  return <div data-catalog-scroll
    className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-black/80 px-4 pb-10 pt-8 backdrop-blur-sm"
    onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
      className="nf-dialog-enter relative mx-auto w-full max-w-4xl rounded-xl bg-nf-surface shadow-2xl outline-none">
      <div data-catalog-close className="pointer-events-none sticky top-0 z-20 flex h-0 items-start justify-end">
        <button aria-label="Close dialog" onClick={onClose} className="pointer-events-auto mr-4 mt-4 flex h-9 w-9 items-center justify-center rounded-full bg-nf-surface text-white hover:bg-[#2a2a2a] focus-visible:ring-2 focus-visible:ring-white"><X className="h-5 w-5" /></button>
      </div>
      {children}
    </div>
  </div>;
}
