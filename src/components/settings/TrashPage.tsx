import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2, Undo2 } from 'lucide-react';
import type { TrashRow } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { daysLeft, emptyTrash, formatBytes, listTrash, purgeTrash, restoreTrash, TRASH_RETENTION_DAYS } from '../../services/files';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import { BTN, BTN_DANGER, Group, Page, Row } from './ui';

const KIND_LABEL: Record<TrashRow['kind'], string> = { movie: 'Movie', tv: 'TV Show', episode: 'Episode' };

export default function TrashPage() {
  const toast = useLibraryStore((s) => s.toast);
  const confirm = useLibraryStore((s) => s.confirm);
  const libraryVersion = useLibraryStore((s) => s.libraryVersion);
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const [busy, setBusy] = useState<number | 'all' | null>(null);

  const refresh = useCallback(() => listTrash().then(setRows), []);
  useEffect(() => {
    void refresh();
  }, [refresh, libraryVersion]);

  const run = async (key: number | 'all', fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const purge = async (row: TrashRow) => {
    const ok = await confirm({
      title: `Permanently delete “${row.label}”?`,
      message: `${formatBytes(row.size_bytes)} will be erased from disk. This can’t be undone.`,
      confirmLabel: 'Delete Forever',
      danger: true,
    });
    if (ok)
      await run(row.id, async () => {
        await purgeTrash(row);
        toast(`Permanently deleted “${row.label}”`, 'success');
      });
  };

  const empty = async () => {
    const total = (rows ?? []).reduce((n, r) => n + r.size_bytes, 0);
    const ok = await confirm({
      title: 'Empty Recently Deleted?',
      message: `${rows?.length} item${rows?.length === 1 ? '' : 's'} (${formatBytes(total)}) will be erased from disk. This can’t be undone.`,
      confirmLabel: 'Empty',
      danger: true,
    });
    if (ok) await run('all', emptyTrash);
  };

  return (
    <Page title="Recently Deleted" description={`Deleted titles stay here for ${TRASH_RETENTION_DAYS} days, then they’re removed from disk for good.`}>
      <Group>
        {!rows ? (
          <Row label="Loading…" />
        ) : !rows.length ? (
          <Row label="Nothing here" description="Titles you delete show up here, ready to restore." />
        ) : (
          rows.map((row) => {
            const left = daysLeft(row);
            return (
              <div key={row.id} className="flex items-center gap-3 px-4 py-3">
                <div className="h-14 w-10 shrink-0 overflow-hidden rounded-sm">
                  <Artwork src={resize(row.poster_path, 'w92')} alt={row.label} className="h-full w-full" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold" title={row.label}>
                    {row.label}
                  </div>
                  <div className="text-xs text-nf-muted">
                    {KIND_LABEL[row.kind]} · {formatBytes(row.size_bytes)} ·{' '}
                    <span className={left <= 3 ? 'text-[#e87c03]' : ''}>
                      {left} day{left === 1 ? '' : 's'} left
                    </span>
                  </div>
                </div>
                <button onClick={() => run(row.id, () => restoreTrash(row))} disabled={busy != null} className={BTN}>
                  {busy === row.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Restore
                </button>
                <button
                  onClick={() => void purge(row)}
                  disabled={busy != null}
                  title="Delete forever"
                  className="flex h-9 w-9 items-center justify-center rounded text-white/50 transition hover:bg-nf-red/20 hover:text-nf-red disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })
        )}
      </Group>
      {!!rows?.length && (
        <button onClick={() => void empty()} disabled={busy != null} className={BTN_DANGER}>
          {busy === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Empty Recently Deleted
        </button>
      )}
    </Page>
  );
}
