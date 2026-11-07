import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, RotateCw, ShieldCheck, X } from 'lucide-react';
import { browseSource, type SourceBrowserSession } from '../../services/browse';
import type { CatalogDetail } from '../../types/browse';
import useSourcePane from '../../hooks/useSourcePane';
import { useModalDialog } from '../../hooks/useModalDialog';

/** Trusted navigation stays above an isolated native source view in the library window. */
export default function SourceBrowser({ item, sourceUrl, onBack, onSelected }: {
  item: CatalogDetail; sourceUrl: string; onBack: () => void; onSelected: () => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const selected = useRef(onSelected);
  selected.current = onSelected;
  const [session, setSession] = useState<SourceBrowserSession | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const pane = useSourcePane(slot, session?.requestId ?? null);
  useModalDialog(root, { onClose: onBack, priority: 110, initialFocus: back });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSession(null); setError('');
    void browseSource(item, item.imdbId, sourceUrl, {
      signal: controller.signal,
      onSelected: () => { if (active) selected.current(); },
      onClosed: () => { if (active && !controller.signal.aborted) { setSession(null); setError('The source browser closed. Try opening it again.'); } },
      onError: (message) => { if (active) setError(message); },
    }).then((opened) => { if (active) setSession(opened); else opened.close(); })
      .catch((reason) => { if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; controller.abort(); };
  }, [item, sourceUrl, attempt]);
  const control = (action: 'back' | 'forward' | 'reload') => {
    setError('');
    void session?.control(action).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const message = error || pane.error;
  return <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Browse torrents for ${item.title}`} className="fixed inset-0 z-[110] flex flex-col bg-nf-bg outline-none">
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-4">
      <button ref={back} onClick={onBack} className="nf-btn-ghost shrink-0 text-sm"><ArrowLeft className="h-4 w-4" />Back to title</button>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">Browse torrents</h2><p className="truncate text-xs text-white/50">{item.title}</p></div>
      <span className="hidden items-center gap-1.5 text-xs text-white/50 lg:flex"><ShieldCheck className="h-4 w-4" />Ad blocking on</span>
      <nav aria-label="Source navigation" className="flex shrink-0 gap-1">
        {([{ action: 'back', label: 'Back one page', Icon: ArrowLeft }, { action: 'forward', label: 'Forward one page', Icon: ArrowRight }, { action: 'reload', label: 'Reload source', Icon: RotateCw }] as const).map(({ action, label, Icon }) =>
          <button key={action} aria-label={label} title={label} disabled={!session} onClick={() => control(action)} className="rounded p-2.5 text-white/70 hover:bg-white/10 disabled:opacity-30"><Icon className="h-4 w-4" /></button>)}
      </nav>
      <button aria-label="Close torrent browser" title="Close torrent browser" onClick={onBack} className="rounded p-2.5 hover:bg-white/10"><X className="h-5 w-5" /></button>
    </header>
    {message && <div role="alert" className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-[#252020] px-5 py-3 text-sm text-red-200"><span>{message}</span><button className="nf-btn-ghost shrink-0 text-sm" onClick={() => { if (error) setAttempt((value) => value + 1); else pane.retry(); }}>Retry</button></div>}
    <div ref={slot} className="mb-2 min-h-0 flex-1 bg-[#181818]">
      {!session && !message && <p role="status" className="flex items-center justify-center gap-3 py-20 text-sm text-white/60"><Loader2 className="h-5 w-5 animate-spin" />Opening your source…</p>}
    </div>
  </div>;
}
