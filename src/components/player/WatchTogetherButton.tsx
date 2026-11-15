import { useState } from 'react';
import { Users } from 'lucide-react';
import { TogetherPanel } from '../../remote/TogetherPanel';
import { createParty, joinParty, leaveParty, refreshParties, setPartyWait, useDesktopParty } from '../../services/watchpartyDesktop';

/** "Watch together" in the desktop player: a participants chip and the party popover above it. */
export default function WatchTogetherButton() {
  const [open, setOpen] = useState(false);
  const { state, rooms, busy, error } = useDesktopParty();
  const count = state?.members.length ?? 0;
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={state ? `Watch together: ${count} watching` : 'Watch together'}
        title="Watch together"
        className={`flex h-12 items-center justify-center gap-1.5 rounded-full text-white transition-transform duration-150 hover:scale-110 ${state ? 'bg-white/15 px-3' : 'w-12'}`}
      >
        <Users className="h-8 w-8" />
        {state && <span className="text-base font-semibold tabular-nums">{count}</span>}
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-10 mb-3">
          <TogetherPanel
            state={state}
            rooms={rooms}
            busy={busy}
            error={error}
            onCreate={() => void createParty()}
            onJoin={(code) => void joinParty(code)}
            onLeave={() => void leaveParty()}
            onWait={setPartyWait}
            onRefresh={() => void refreshParties()}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
