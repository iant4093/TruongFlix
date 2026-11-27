import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'framer-motion';
import { useMusicNav } from '../nav';
import { TrackPointMenu } from './TrackMenu';
import { leavingClass, useLeaving } from '../../lib/leaving';

interface Prompt {
  title: string;
  value: string;
  action: string;
  /** A yes/no question instead of a name: this text is shown and there's no field. */
  message?: string;
  /** A few lines of text (a description) instead of a name; it may be left empty. */
  text?: { placeholder: string; max: number };
  resolve: (v: string | null) => void;
}

const usePrompt = create<{ prompt: Prompt | null }>(() => ({ prompt: null }));

/** Each prompt gets its own dialog: one opened while the last is still fading out starts with its own text. */
const promptKeys = new WeakMap<Prompt, number>();
let nextPromptKey = 0;
const promptKey = (p: Prompt) => {
  if (!promptKeys.has(p)) promptKeys.set(p, ++nextPromptKey);
  return promptKeys.get(p)!;
};

/** Asks for a name (new playlist, rename). Resolves null when cancelled. */
export function askName(title: string, value = '', action = 'Save'): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ prompt: { title, value, action, resolve } }));
}

/**
 * Asks for a short text that may be left empty (a playlist's description). Resolves '' when
 * emptied, null when cancelled.
 */
export function askText(title: string, value: string, placeholder: string, max: number, action = 'Save'): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ prompt: { title, value, action, text: { placeholder, max }, resolve } }));
}

/** Asks before something destructive, in the app's own style (a native confirm box can't be
 * answered with a controller, and freezes the page while open). */
export async function askConfirm(title: string, message: string, action: string): Promise<boolean> {
  const answer = await new Promise<string | null>((resolve) => usePrompt.setState({ prompt: { title, value: 'yes', action, message, resolve } }));
  return answer != null;
}

function NamePrompt({ prompt, closing }: { prompt: Prompt; closing: boolean }) {
  const [value, setValue] = useState(prompt.value);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const text = prompt.text;
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const done = (v: string | null) => {
    usePrompt.setState({ prompt: null });
    prompt.resolve(v);
  };
  return (
    <div className={`nf-fade fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-6 ${leavingClass(closing)}`} onPointerDown={(e) => e.target === e.currentTarget && done(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() || text) done(value.trim());
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
        {prompt.message ? (
          <p className="mt-2 text-sm text-white/70">{prompt.message}</p>
        ) : text ? (
          <>
            <textarea
              ref={input}
              value={value}
              maxLength={text.max}
              rows={4}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // Enter saves: a description is one paragraph.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  done(value.trim());
                }
              }}
              placeholder={text.placeholder}
              className="mt-4 w-full resize-none rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-base outline-none focus:border-white/50"
            />
            <div className="mt-1 text-right text-xs text-white/40">
              {value.length}/{text.max}
            </div>
          </>
        ) : (
          <input
            ref={input}
            value={value}
            maxLength={120}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Playlist name"
            className="mt-4 h-11 w-full rounded-lg border border-white/15 bg-black/30 px-3 text-base outline-none focus:border-white/50"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus={!!prompt.message} onClick={() => done(null)} className="h-10 rounded-lg px-4 text-sm font-semibold text-white/80 hover:bg-white/10">
            Cancel
          </button>
          <button type="submit" disabled={!value.trim() && !text} className="h-10 rounded-lg bg-[#fa2d48] px-4 text-sm font-semibold text-white disabled:opacity-40">
            {prompt.action}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Toasts and the name prompt; rendered once by each app. */
export default function MusicOverlays() {
  const prompt = useLeaving(usePrompt((s) => s.prompt), 240);
  const toast = useMusicNav((s) => s.toast);
  return createPortal(
    <>
      {prompt.shown && <NamePrompt key={promptKey(prompt.shown)} prompt={prompt.shown} closing={prompt.closing} />}
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
