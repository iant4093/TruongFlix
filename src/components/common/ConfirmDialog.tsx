import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';

/** App-styled confirmation dialog driven by `useLibraryStore().confirm(...)`. */
export default function ConfirmDialog() {
  const req = useLibraryStore((s) => s.confirmRequest);
  const resolve = useLibraryStore((s) => s.resolveConfirm);
  // Destructive dialogs focus Cancel so a stray Enter never deletes anything.
  const focusRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!req) return;
    focusRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      resolve(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req, resolve]);

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          key="confirm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => e.target === e.currentTarget && resolve(false)}
          className="fixed inset-0 z-[190] flex items-center justify-center bg-black/70 p-6 backdrop-blur-xs"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.18 }}
            role="alertdialog"
            className="w-full max-w-md rounded-xl bg-nf-surface p-7 shadow-2xl"
          >
            <div className="flex items-start gap-4">
              {req.danger && (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-nf-red/15">
                  <AlertTriangle className="h-5 w-5 text-nf-red" />
                </span>
              )}
              <div className="min-w-0">
                <h2 className="text-xl font-bold leading-snug">{req.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-nf-secondary">{req.message}</p>
              </div>
            </div>
            <div className="mt-7 flex justify-end gap-2">
              <button ref={req.danger ? focusRef : undefined} onClick={() => resolve(false)} className="nf-btn-ghost h-10 px-5">
                Cancel
              </button>
              <button
                ref={req.danger ? undefined : focusRef}
                onClick={() => resolve(true)}
                className={`h-10 rounded px-5 text-sm font-semibold transition-colors ${
                  req.danger ? 'bg-nf-red text-white hover:bg-nf-redHover' : 'bg-white text-black hover:bg-white/80'
                }`}
              >
                {req.confirmLabel ?? 'OK'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
