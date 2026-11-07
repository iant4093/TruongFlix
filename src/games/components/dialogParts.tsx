import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen, X } from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog';

/** Free bytes on the drive holding `path` (null while unknown). */
export function useDiskFree(path: string): number | null {
  const [free, setFree] = useState<{ path: string; bytes: number | null } | null>(null);
  const target = path.trim();
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const drive = /^[a-z]:[\\/]?/i.exec(target)?.[0];
    const timer = window.setTimeout(async () => {
      let bytes: number | null = null;
      try {
        bytes = await invoke<number>('games_disk_free', { path: target });
      } catch {
        if (drive) bytes = await invoke<number>('games_disk_free', { path: `${drive.slice(0, 2)}\\` }).catch(() => null);
      }
      if (!cancelled) setFree({ path: target, bytes: typeof bytes === 'number' ? bytes : null });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [target]);
  return target && free?.path === target ? free.bytes : null;
}

export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false, title, defaultPath: defaultPath || undefined });
  return typeof picked === 'string' && picked ? picked : null;
}

export function Section({ title, id, children, aside }: { title: string; id: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 id={id} className="text-xs font-semibold uppercase tracking-wider text-nf-muted">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Rounded card that groups rows, like the option cards in Add Torrent and Settings. */
export const CARD = 'rounded-lg border border-white/10 bg-white/[0.03]';
export const CARD_ROWS = `${CARD} divide-y divide-white/[0.08] overflow-hidden`;
export const SELECT = 'h-10 w-full rounded border border-white/15 bg-black/40 px-3 text-sm text-white outline-none focus:border-white/50';

export const CHECKBOX = 'h-4 w-4 shrink-0 accent-[#e50914]';

/** The app's option-dialog frame: header with art, scrolling body and a footer bar of actions. */
export function GameDialog({ title, subtitle, art, onClose, footer, children, wide = false }: {
  title: string;
  subtitle?: ReactNode;
  art?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, priority: 100 });
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      onMouseDown={onBackdropMouseDown}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/75 px-4 py-8 backdrop-blur-xs"
    >
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
        className={`my-auto w-full ${wide ? 'max-w-3xl' : 'max-w-2xl'} overflow-hidden rounded-xl bg-nf-surface shadow-2xl outline-none ring-1 ring-white/10`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3.5">
            {art}
            <div className="min-w-0">
              <h2 className="truncate text-xl font-bold">{title}</h2>
              {subtitle && <p className="truncate text-xs text-nf-secondary">{subtitle}</p>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="shrink-0 rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[72vh] min-w-0 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2.5 border-t border-white/10 bg-black/30 px-6 py-4">{footer}</div>}
      </motion.div>
    </motion.div>
  );
}

/** A chosen folder shown as name + full path, with a change button (like Add Torrent's library location). */
export function FolderChoice({ path, empty, buttonLabel, onChange, testId }: {
  path: string;
  empty: string;
  buttonLabel: string;
  onChange: () => void;
  testId?: string;
}) {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1" title={path || undefined} data-testid={testId}>
        {path ? <>
          <div className="truncate text-sm font-semibold">{leaf}</div>
          <div className="truncate font-mono text-[11px] text-nf-muted">{path}</div>
        </> : <div className="text-sm text-nf-muted">{empty}</div>}
      </div>
      <button type="button" className="nf-btn-ghost h-8 shrink-0 px-3 py-0 text-xs" onClick={onChange} aria-label={buttonLabel}>
        <FolderOpen className="h-3.5 w-3.5" /> {path ? 'Change' : 'Choose'}
      </button>
    </div>
  );
}

/** Icon tile used in dialog headers. */
export function DialogIcon({ children }: { children: ReactNode }) {
  return <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-nf-red/15 text-nf-red">{children}</div>;
}
