import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, FileVideo, RotateCcw, X } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import * as db from '../../services/db';
import { rootFor } from '../../services/files';
import { applyRenames, planRenames, undoRename, type RenamePlanItem } from '../../services/rename';

const rel = (path: string, roots: string[]) => {
  const root = rootFor(path, roots);
  return root ? path.slice(root.length).replace(/^[\\/]/, '') : path;
};

/** Plex-style renaming with a full preview first, and undo for recent batches. */
export default function RenameModal() {
  const setOverlay = useLibraryStore((s) => s.setOverlay);
  const roots = useLibraryStore((s) => s.settings.media_directories);
  const libraryVersion = useLibraryStore((s) => s.libraryVersion);
  const toast = useLibraryStore((s) => s.toast);
  const confirm = useLibraryStore((s) => s.confirm);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [batches, setBatches] = useState<db.RenameBatch[]>([]);

  // Re-plan whenever the library reloads (after a rename or undo).
  const { plan, skipped } = useMemo(() => planRenames(), [libraryVersion]);
  const chosen = plan.filter((p) => !excluded.has(p.from));

  useEffect(() => {
    void db.listRenameBatches().then(setBatches);
  }, [libraryVersion]);

  const toggle = (p: RenamePlanItem) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(p.from)) next.delete(p.from);
      else next.add(p.from);
      return next;
    });

  const apply = async () => {
    if (!chosen.length) return;
    const ok = await confirm({
      title: `Rename ${chosen.length} file${chosen.length === 1 ? '' : 's'}?`,
      message: 'Files are moved into tidy folders with their subtitles and artwork. You can undo this from this screen.',
      confirmLabel: 'Rename',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await applyRenames(chosen, `${chosen.length} file${chosen.length === 1 ? '' : 's'}`);
      setExcluded(new Set());
      if (res.errors.length) toast(`Renamed ${res.renamed}; ${res.errors.length} failed: ${res.errors[0]}`, 'error');
      else toast(`Renamed ${res.renamed} file${res.renamed === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      toast(`Rename failed: ${String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const undo = async (b: db.RenameBatch) => {
    setBusy(true);
    try {
      const res = await undoRename(b);
      if (res.errors.length) toast(`Undo finished with ${res.errors.length} problem(s): ${res.errors[0]}`, 'error');
      else toast('Rename undone', 'success');
    } catch (e) {
      toast(`Undo failed: ${String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onMouseDown={(e) => e.target === e.currentTarget && setOverlay(null)}
      className="fixed inset-0 z-[140] flex justify-center overflow-y-auto bg-black/75 px-4 py-10 backdrop-blur-xs"
    >
      <div className="relative h-max w-full max-w-4xl rounded-xl bg-nf-surface p-8 shadow-2xl">
        <button onClick={() => setOverlay(null)} aria-label="Close" className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10">
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-3xl font-bold">Rename Files</h2>
        <p className="mt-2 max-w-2xl text-sm text-nf-secondary">
          Plex-style names: <span className="font-mono text-white/80">Movie (Year)/Movie (Year).mkv</span> and{' '}
          <span className="font-mono text-white/80">Show/Season 01/Show - S01E01.mkv</span>. Subtitles, .nfo files and artwork move with their
          video. Files stay inside their media folder.
        </p>

        <div className="mt-6 flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            {plan.length ? `${chosen.length} of ${plan.length} file${plan.length === 1 ? '' : 's'} will be renamed` : 'Everything is already named correctly'}
          </h3>
          <button onClick={() => void apply()} disabled={busy || !chosen.length} className="nf-btn-play px-6 py-2 text-base disabled:opacity-50">
            Rename {chosen.length || ''}
          </button>
        </div>

        {plan.length > 0 && (
          <div className="mt-4 max-h-[50vh] divide-y divide-white/10 overflow-y-auto rounded-md border border-white/10">
            {plan.map((p) => {
              const off = excluded.has(p.from);
              return (
                <label key={p.from} className={`flex cursor-pointer items-start gap-3 px-4 py-3 text-sm hover:bg-white/5 ${off ? 'opacity-45' : ''}`}>
                  <input type="checkbox" checked={!off} onChange={() => toggle(p)} className="mt-1 accent-[#E50914]" />
                  <FileVideo className="mt-0.5 h-4 w-4 shrink-0 text-nf-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.label}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-xs">
                      <span className="break-all text-nf-muted line-through decoration-white/30">{rel(p.from, roots)}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-nf-muted" />
                      <span className="break-all text-nf-green">{rel(p.to, roots)}</span>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {skipped.length > 0 && (
          <details className="mt-4 text-sm text-nf-secondary">
            <summary className="cursor-pointer">{skipped.length} skipped</summary>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              {skipped.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </details>
        )}

        {batches.length > 0 && (
          <section className="mt-8">
            <h3 className="mb-3 text-lg font-semibold">Recent renames</h3>
            <div className="divide-y divide-white/10 rounded-md border border-white/10">
              {batches.map((b) => {
                const moves = JSON.parse(b.moves) as unknown[];
                return (
                  <div key={b.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                    <div className="flex-1">
                      <div className="font-semibold">{b.label}</div>
                      <div className="text-xs text-nf-muted">
                        {new Date(b.created_at.replace(' ', 'T') + 'Z').toLocaleString()} · {moves.length} file{moves.length === 1 ? '' : 's'} moved
                      </div>
                    </div>
                    {b.undone ? (
                      <span className="text-xs text-nf-muted">Undone</span>
                    ) : (
                      <button
                        onClick={() => void undo(b)}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded border border-white/30 px-3 py-1.5 text-xs font-semibold hover:border-white disabled:opacity-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Undo
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </motion.div>
  );
}
