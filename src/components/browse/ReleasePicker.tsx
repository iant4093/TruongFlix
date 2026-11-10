import { Download, Play, X } from 'lucide-react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { BrowseTarget, SourceRelease } from '../../types/browse';
import type { TorrentMode } from '../../types/media';

type Quality = BrowseTarget['quality'];

export default function ReleasePicker({ id, selection, busy, quality, releases, resultsRef, onClose, onSearch, onSelect }: {
  id: string;
  selection: string;
  busy: boolean;
  quality: Quality | null;
  releases: SourceRelease[] | null;
  resultsRef: RefObject<HTMLDivElement>;
  onClose: () => void;
  onSearch: (quality: Quality) => void;
  onSelect: (mode: TorrentMode, quality: Quality, release: SourceRelease) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const focusQuality = useRef(true);
  useLayoutEffect(() => {
    if (busy || !focusQuality.current) return;
    focusQuality.current = false;
    const button = panel.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?? panel.current?.querySelector<HTMLButtonElement>('button[aria-pressed]');
    button?.focus({ preventScroll: true });
  }, [busy]);

  return <section ref={panel} id={id} aria-labelledby={`${id}-heading`} className="mb-5 rounded-lg border border-white/15 bg-white/5 p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id={`${id}-heading`} className="text-lg font-semibold">Compare releases</h2>
        <p className="mt-1 text-sm text-nf-secondary">{selection} · Up to five by reported seed count</p>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex gap-2" aria-label="Release quality" role="group">
          {(['1080p', '4K'] as const).map((value) => <button key={value} type="button"
            aria-pressed={quality === value} disabled={busy} onClick={() => { focusQuality.current = true; onSearch(value); }}
            className={`rounded-md px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${quality === value
              ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}>
            {value}
          </button>)}
        </div>
        <button type="button" aria-label="Close release picker" title="Close release picker" disabled={busy}
          onClick={onClose} className="rounded p-2 text-nf-secondary hover:bg-white/10 hover:text-white disabled:opacity-50">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
    {quality == null && <p className="mt-4 text-sm text-nf-secondary">Choose 1080p or 4K to search your source.</p>}
    {releases && quality != null && <div ref={resultsRef} className="scroll-mt-16">
      {releases.length === 0 ? <p className="mt-4 text-sm text-nf-secondary">No seeded {quality} releases matched this selection.</p> : <>
        <p className="mt-4 text-xs text-nf-muted">Quality is advertised by the source. TruongFlix checks the selected files before starting.</p>
        <ol className="mt-2 divide-y divide-white/10">
          {releases.map((release) => <li key={release.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="break-words text-sm font-semibold">{release.title}</p>
              <p className="mt-1 text-xs text-nf-secondary">{release.seeders?.toLocaleString()} reported seeds{release.size && ` · ${release.size}`}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="nf-btn-ghost text-sm disabled:opacity-50" disabled={busy}
                aria-label={`Stream ${release.title}`} onClick={() => { focusQuality.current = true; onSelect('stream', quality, release); }}><Play className="h-4 w-4" />Stream</button>
              <button type="button" className="nf-btn-ghost text-sm disabled:opacity-50" disabled={busy}
                aria-label={`Download ${release.title}`} onClick={() => { focusQuality.current = true; onSelect('download', quality, release); }}><Download className="h-4 w-4" />Download</button>
            </div>
          </li>)}
        </ol>
      </>}
    </div>}
  </section>;
}
