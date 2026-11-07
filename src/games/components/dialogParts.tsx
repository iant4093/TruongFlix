import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

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

export function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-xs font-semibold uppercase tracking-widest text-white/50">
        {title}
      </h3>
      {children}
    </section>
  );
}

export const CHECKBOX = 'h-4 w-4 shrink-0 accent-[#e50914]';
