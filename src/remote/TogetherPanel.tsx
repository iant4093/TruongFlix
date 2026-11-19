import { useEffect, useState } from 'react';
import { Crown, Loader2, LogOut, RefreshCw, Users, X } from 'lucide-react';
import { memberLabel, type TogetherRoomSummary, type TogetherState } from './together';

/** The "Watch together" popover, shared by the browser player and the desktop player. */
export function TogetherPanel({
  state,
  rooms,
  busy,
  error,
  onCreate,
  onJoin,
  onLeave,
  onWait,
  onRefresh,
  onClose,
}: {
  state: TogetherState | null;
  rooms: TogetherRoomSummary[] | null;
  busy: boolean;
  error: string;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
  onWait: (on: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState('');
  useEffect(() => {
    if (!state) onRefresh();
  }, [!!state]);

  return (
    <div
      role="dialog"
      aria-label="Watch together"
      className="max-h-[calc(100dvh-6rem)] w-[min(360px,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-nf-surface/95 p-4 text-left text-white shadow-2xl backdrop-blur"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/90">
          <Users className="h-4 w-4" /> Watch together
        </h3>
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1 text-white/70 hover:bg-white/10 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && <p className="mb-3 rounded bg-nf-red/15 px-3 py-2 text-xs text-white">{error}</p>}

      {state ? (
        <div className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-nf-muted">Party code</div>
            <div className="font-mono text-2xl font-bold tracking-[0.3em]" aria-label={`Party code ${state.code.split('').join(' ')}`}>
              {state.code}
            </div>
            <div className="truncate text-xs text-nf-secondary">{state.label}</div>
          </div>
          <ul className="max-h-48 space-y-1 overflow-y-auto" aria-label="Who’s watching">
            {state.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2 rounded bg-white/5 px-2.5 py-1.5 text-sm">
                {m.host ? <Crown className="h-3.5 w-3.5 shrink-0 text-nf-gold" aria-label="Started the party" /> : <span className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">
                  {memberLabel(m)}
                  {m.you && <span className="text-nf-muted"> (you)</span>}
                </span>
                {m.buffering && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-nf-muted" aria-label="Loading" />}
              </li>
            ))}
          </ul>
          {state.held && <p className="text-xs text-nf-secondary">Waiting for everyone to catch up…</p>}
          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
            <span>
              Wait for everyone
              <span className="block text-xs text-nf-muted">Pause for all while someone is loading</span>
            </span>
            <input type="checkbox" checked={state.waitForAll} onChange={(e) => onWait(e.target.checked)} className="h-4 w-4 accent-[#E50914]" />
          </label>
          <button onClick={onLeave} className="nf-btn-ghost w-full">
            <LogOut className="h-4 w-4" /> Leave party
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={onCreate} disabled={busy} className="nf-btn-red w-full py-2 text-sm">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />} Start a watch party
          </button>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) onJoin(code.trim());
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              placeholder="Party code"
              aria-label="Party code"
              autoCapitalize="characters"
              autoComplete="off"
              className="nf-input min-w-0 flex-1 px-3 py-2 font-mono uppercase tracking-widest"
            />
            <button type="submit" disabled={busy || code.length < 6} className="nf-btn-ghost">
              Join
            </button>
          </form>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-nf-muted">
              Open parties
              <button onClick={onRefresh} aria-label="Refresh open parties" className="rounded-full p-1 hover:bg-white/10 hover:text-white">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            {rooms == null ? (
              <Loader2 className="h-4 w-4 animate-spin text-nf-muted" />
            ) : rooms.length === 0 ? (
              <p className="text-xs text-nf-muted">No watch parties right now.</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {rooms.map((r) => (
                  <li key={r.code}>
                    <button
                      onClick={() => onJoin(r.code)}
                      disabled={busy}
                      className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-nf-secondary transition hover:bg-white/5 hover:text-white"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-white">{r.label}</span>
                        <span className="block truncate text-xs">{r.members.join(', ')}</span>
                      </span>
                      <span className="font-mono text-xs">{r.code}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Small toasts for party events ("Ian paused"). */
export function TogetherToasts({ toasts }: { toasts: { id: number; text: string }[] }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed left-1/2 top-[max(4.5rem,calc(env(safe-area-inset-top)+3.5rem))] z-[300] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-center gap-2 rounded-full border border-white/15 bg-black/85 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur sm:text-sm">
          <Users className="h-4 w-4 shrink-0 text-nf-red" />
          {t.text}
        </div>
      ))}
    </div>
  );
}
