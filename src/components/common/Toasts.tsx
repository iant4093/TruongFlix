import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, RefreshCw, X } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { miniRect } from '../../services/player';
import ProgressBar from './ProgressBar';

const SCAN_RESULT_MS = 4000;

const enter = {
  layout: 'position' as const,
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, x: 40, transition: { duration: 0.18 } },
  transition: { duration: 0.25, ease: [0.21, 0, 0.27, 1] as const },
};

/** Notification stack + the scan-progress card (bottom-right). */
export default function Toasts() {
  const toasts = useLibraryStore((s) => s.toasts);
  const dismiss = useLibraryStore((s) => s.dismissToast);
  const scan = useLibraryStore((s) => s.scan);

  // The scan card stays mounted after a scan and switches to its result state in place
  // (same element, same height), so nothing else in the stack shifts when a scan finishes.
  const [showScan, setShowScan] = useState(false);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (scan.running) {
      wasRunning.current = true;
      setShowScan(true);
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    const t = window.setTimeout(() => setShowScan(false), SCAN_RESULT_MS);
    return () => window.clearTimeout(t);
  }, [scan.running]);

  const finished = !scan.running;
  const failed = finished && scan.phase === 'error';
  // Folder-watcher scans stay silent unless something was actually added or removed.
  const scanVisible = showScan && (!scan.quiet || scan.phase === 'matching' || (finished && !failed && (scan.added > 0 || scan.removed > 0)));
  const mini = useLibraryStore((s) => s.playerMini);
  const bottom = mini ? window.innerHeight - miniRect().y + 16 : 24;
  const title = scan.running
    ? scan.phase === 'ratings'
      ? 'Updating IMDb ratings'
      : scan.phase === 'matching'
        ? 'Updating library'
        : 'Scanning folders'
    : failed
      ? 'Scan failed'
      : scan.added || scan.removed
        ? 'Library updated'
        : 'Library is up to date';

  return (
    <div className="pointer-events-none fixed right-6 z-[180] flex w-[360px] flex-col items-end gap-2 transition-[bottom]" style={{ bottom }}>
      {/* popLayout removes exiting items from the flow immediately, so the stack never jumps. */}
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            {...enter}
            className="pointer-events-auto flex w-full items-start gap-3 rounded-md border border-white/10 bg-[#232323]/95 px-4 py-3 text-sm text-white shadow-2xl backdrop-blur"
          >
            {t.kind === 'error' ? (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-nf-red" />
            ) : t.kind === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-nf-green" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-white/70" />
            )}
            <span className="flex-1 leading-snug">{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="text-white/50 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        ))}

        {scanVisible && (
          <motion.div
            key="scan"
            {...enter}
            className="pointer-events-auto w-full overflow-hidden rounded-md border border-white/10 bg-[#181818]/95 shadow-2xl backdrop-blur"
          >
            <div className="flex items-center gap-3 px-4 pb-2.5 pt-3">
              {scan.running ? (
                <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-nf-red" />
              ) : failed ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-nf-red" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-nf-green" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between text-sm font-semibold">
                  <span>{title}</span>
                  {scan.running && scan.total > 0 && (
                    <span className="text-xs font-normal tabular-nums text-nf-secondary">
                      {scan.current} / {scan.total}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-nf-muted">{scan.message}</div>
              </div>
              {finished && (
                <button onClick={() => setShowScan(false)} className="self-start text-white/50 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <ProgressBar
              value={
                finished
                  ? 1
                  : scan.phase === 'ratings'
                    ? Number(scan.message.match(/(\d+)%/)?.[1] ?? 0) / 100
                    : scan.total
                      ? scan.current / scan.total
                      : 0
              }
              height={3}
              className={finished && !failed ? '[&>div]:bg-nf-green' : ''}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
