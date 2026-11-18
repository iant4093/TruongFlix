import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'framer-motion';
import { useMusicNav } from '../nav';
import { TrackPointMenu } from './TrackMenu';

interface Prompt {
  title: string;
  value: string;
  action: string;
  resolve: (v: string | null) => void;
}

const usePrompt = create<{ prompt: Prompt | null }>(() => ({ prompt: null }));

/** Asks for a name (new playlist, rename). Resolves null when cancelled. */
export function askName(title: string, value = '', action = 'Save'): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ prompt: { title, value, action, resolve } }));
}

function NamePrompt({ prompt }: { prompt: Prompt }) {
  const [value, setValue] = useState(prompt.value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const done = (v: string | null) => {
    usePrompt.setState({ prompt: null });
    prompt.resolve(v);
  };
  return (
    <div className="nf-fade fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-6" onPointerDown={(e) => e.target === e.currentTarget && done(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) done(value.trim());
        }}
        className="nf-pop-in w-full max-w-sm rounded-2xl border border-white/10 bg-[#2c2c2e] p-5 shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            done(null);
          }
        }}
      >
        <h2 className="text-lg font-semibold">{prompt.title}</h2>
        <input
          ref={input}
          value={value}
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Playlist name"
          className="mt-4 h-11 w-full rounded-lg border border-white/15 bg-black/30 px-3 text-base outline-none focus:border-white/50"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => done(null)} className="h-10 rounded-lg px-4 text-sm font-semibold text-white/80 hover:bg-white/10">
            Cancel
          </button>
          <button type="submit" disabled={!value.trim()} className="h-10 rounded-lg bg-[#fa2d48] px-4 text-sm font-semibold text-white disabled:opacity-40">
            {prompt.action}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Toasts and the name prompt; rendered once by each app. */
export default function MusicOverlays() {
  const prompt = usePrompt((s) => s.prompt);
  const toast = useMusicNav((s) => s.toast);
  return createPortal(
    <>
      {prompt && <NamePrompt prompt={prompt} />}
      <TrackPointMenu />
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="pointer-events-none fixed inset-x-0 bottom-[calc(6.5rem+env(safe-area-inset-bottom))] z-[310] flex justify-center px-4"
          >
            <div className="rounded-full bg-[#3a3a3c]/95 px-5 py-2.5 text-sm font-medium shadow-xl backdrop-blur">{toast.text}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
}
