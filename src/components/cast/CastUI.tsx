import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Cast, Loader2, Pause, Play, RefreshCw, RotateCcw, RotateCw, Tv, X } from 'lucide-react';
import type { PlayTarget } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { castControl, castSeek, castTo, discoverDevices, stopCasting, type CastDevice } from '../../services/cast';
import { formatTimestamp } from '../../store/selectors';

const IS_MAC = navigator.userAgent.includes('Mac');

/** "Cast to…" device picker. */
export function CastPicker() {
  const picker = useLibraryStore((s) => s.castPicker);
  // Passed as a snapshot so the closing animation still has it.
  return <AnimatePresence>{picker && <Picker key="picker" picker={picker} />}</AnimatePresence>;
}

function Picker({ picker }: { picker: { target: PlayTarget; start: number } }) {
  const setPicker = useLibraryStore((s) => s.setCastPicker);
  const [devices, setDevices] = useState<CastDevice[] | null>(null);
  const search = () => {
    setDevices(null);
    void discoverDevices().then(setDevices).catch(() => setDevices([]));
  };
  useEffect(search, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => e.target === e.currentTarget && setPicker(null)}
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/70 p-6 backdrop-blur-xs"
    >
      <motion.div initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} className="w-full max-w-md rounded-xl bg-nf-surface p-6 shadow-2xl ring-1 ring-white/10">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Cast className="h-5 w-5" /> Cast to a TV
          </h2>
          <button onClick={() => setPicker(null)} aria-label="Close" className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 text-sm text-nf-secondary">{picker.target.label}</p>
        {devices == null ? (
          <div className="flex items-center gap-3 py-8 text-nf-secondary">
            <Loader2 className="h-5 w-5 animate-spin" /> Looking for Chromecasts and TVs…
          </div>
        ) : devices.length ? (
          <div className="divide-y divide-white/10 overflow-hidden rounded-lg border border-white/10">
            {devices.map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  setPicker(null);
                  void castTo(d, picker.target, picker.start);
                }}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/5"
              >
                {d.kind === 'chromecast' ? <Cast className="h-5 w-5 text-nf-secondary" /> : <Tv className="h-5 w-5 text-nf-secondary" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{d.name}</span>
                  <span className="block truncate text-xs text-nf-muted">
                    {d.kind === 'chromecast' ? 'Chromecast' : 'Smart TV (DLNA)'}
                    {d.model ? ` · ${d.model}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-dashed border-white/15 p-4 text-sm text-nf-secondary">
            <p className="font-semibold text-white">No TVs found</p>
            <p>Make sure your Chromecast or smart TV is on and connected to the same network as this computer.</p>
            {IS_MAC && <p>If macOS asked, allow TruongFlix to find devices on your local network (System Settings › Privacy &amp; Security › Local Network).</p>}
          </div>
        )}
        <button onClick={search} disabled={devices == null} className="nf-btn-ghost mt-4 h-9 px-3 py-0 text-sm">
          <RefreshCw className="h-4 w-4" /> Search again
        </button>
      </motion.div>
    </motion.div>
  );
}

const STATE_LABEL: Record<string, string> = {
  connecting: 'Connecting…',
  buffering: 'Loading…',
  playing: 'Playing',
  paused: 'Paused',
  idle: 'Stopped',
  ended: 'Finished',
  error: 'Couldn’t play',
};

/** Controls for what's playing on the TV, along the bottom of the app. */
export function CastBar() {
  const cast = useLibraryStore((s) => s.cast);
  const mini = useLibraryStore((s) => s.playerMini);
  const [scrub, setScrub] = useState<number | null>(null);
  if (!cast) return null;
  const absolute = cast.offset + cast.time;
  const shown = scrub ?? absolute;
  const busy = cast.state === 'connecting' || cast.state === 'buffering';

  return (
    <div className={`pointer-events-none fixed inset-x-0 bottom-4 z-[115] flex justify-center ${mini ? 'hidden' : ''}`}>
    <motion.div
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="pointer-events-auto w-[min(820px,94vw)] overflow-hidden rounded-xl bg-[#1f1f1f]/95 shadow-[0_12px_40px_rgba(0,0,0,0.7)] ring-1 ring-white/10 backdrop-blur"
    >
      <div className="flex items-center gap-4 p-3">
        <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded bg-black">{cast.image && <img src={cast.image} alt="" className="h-full w-full object-cover" />}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{cast.title}</div>
          <div className="truncate text-xs text-nf-secondary">
            {cast.subtitle ? `${cast.subtitle} · ` : ''}
            <span className={cast.state === 'error' ? 'text-nf-red' : ''}>
              {cast.message ?? STATE_LABEL[cast.state]} on {cast.device.name}
            </span>
            {cast.converting && cast.state !== 'error' && <span className="text-nf-muted"> · converted for the TV</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => void castSeek(absolute - 10)} disabled={busy} title="Back 10 seconds" className="rounded-full p-2 hover:bg-white/10 disabled:opacity-40">
            <RotateCcw className="h-5 w-5" />
          </button>
          <button
            onClick={() => castControl(cast.state === 'playing' ? 'pause' : 'play')}
            disabled={busy || cast.state === 'error'}
            title={cast.state === 'playing' ? 'Pause' : 'Play'}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black hover:bg-white/80 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : cast.state === 'playing' ? <Pause className="h-5 w-5 fill-black" strokeWidth={0} /> : <Play className="ml-0.5 h-5 w-5 fill-black" strokeWidth={0} />}
          </button>
          <button onClick={() => void castSeek(absolute + 10)} disabled={busy} title="Forward 10 seconds" className="rounded-full p-2 hover:bg-white/10 disabled:opacity-40">
            <RotateCw className="h-5 w-5" />
          </button>
          <button onClick={() => void stopCasting()} title="Stop casting" className="ml-2 rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 pb-3">
        <span className="w-14 text-right text-xs tabular-nums text-nf-secondary">{formatTimestamp(shown)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, cast.duration)}
          value={Math.min(shown, cast.duration)}
          disabled={busy}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={() => {
            if (scrub != null) void castSeek(scrub);
            setScrub(null);
          }}
          onKeyUp={() => {
            if (scrub != null) void castSeek(scrub);
            setScrub(null);
          }}
          className="h-1 flex-1 accent-[#e50914]"
        />
        <span className="w-14 text-xs tabular-nums text-nf-secondary">{formatTimestamp(cast.duration)}</span>
      </div>
    </motion.div>
    </div>
  );
}
