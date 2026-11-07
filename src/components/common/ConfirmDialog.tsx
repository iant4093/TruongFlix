import { useId, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import Dialog from './Dialog';

/** App-styled confirmation dialog driven by `useLibraryStore().confirm(...)`. */
export default function ConfirmDialog() {
  const req = useLibraryStore((s) => s.confirmRequest);
  const resolve = useLibraryStore((s) => s.resolveConfirm);
  // Destructive dialogs focus Cancel so a stray Enter never deletes anything.
  const focusRef = useRef<HTMLButtonElement>(null);
  const title = useId();
  const message = useId();

  if (!req) return null;
  return (
    <Dialog
      onClose={() => resolve(false)}
      priority={190}
      size="sm"
      role="alertdialog"
      chrome="none"
      labelledBy={title}
      describedBy={message}
      initialFocus={focusRef}
      focusKey={req}
      bodyClassName="p-7"
    >
      <div className="flex items-start gap-4">
        {req.danger && (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-nf-red/15">
            <AlertTriangle className="h-5 w-5 text-nf-red" />
          </span>
        )}
        <div className="min-w-0">
          <h2 id={title} className="text-xl font-bold leading-snug">{req.title}</h2>
          <p id={message} className="mt-2 whitespace-pre-line text-sm leading-relaxed text-nf-secondary">{req.message}</p>
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
    </Dialog>
  );
}
