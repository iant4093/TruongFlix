import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen } from 'lucide-react';
import Dialog from '../../components/common/Dialog';
import { basename } from '../../lib/path';

export { DialogIcon } from '../../components/common/Dialog';

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
  return (
    <Dialog
      onClose={onClose}
      priority={100}
      size={wide ? 'lg' : 'md'}
      title={<span className="block truncate">{title}</span>}
      description={subtitle ? <p className="truncate text-xs">{subtitle}</p> : undefined}
      icon={art}
      footer={footer ?? undefined}
      divided
      bodyClassName="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
    >
      {children}
    </Dialog>
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
  const leaf = basename(path);
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
