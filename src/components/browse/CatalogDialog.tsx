import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
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
    ref.current?.focus();
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
  return <motion.div data-catalog-scroll initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}
    className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-black/80 px-4 pb-10 pt-8 backdrop-blur-sm"
    onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <motion.div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
      initial={{ y: 24, scale: 0.97 }} animate={{ y: 0, scale: 1 }} transition={{ duration: 0.23 }}
      className="relative mx-auto w-full max-w-5xl rounded-xl bg-nf-surface shadow-2xl outline-none">
      <div data-catalog-close className="pointer-events-none sticky top-0 z-20 flex h-0 justify-end pr-4 pt-4">
        <button aria-label="Close dialog" onClick={onClose} className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#181818]/90 hover:bg-[#333] focus-visible:ring-2 focus-visible:ring-white"><X className="h-5 w-5" /></button>
      </div>
      {children}
    </motion.div>
  </motion.div>;
}
