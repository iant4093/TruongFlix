import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { Delete, Lock, X } from 'lucide-react';
import { useLibraryStore, type PinRequest } from '../../store/useLibraryStore';
import { FullScreenOverlay } from '../common/Dialog';
import IconButton from '../common/IconButton';

/** 4-digit PIN entry (keyboard or on-screen keypad). */
export default function PinPrompt() {
  const request = useLibraryStore((s) => s.pinRequest);
  return <AnimatePresence>{request && <Pad key={request.title} request={request} />}</AnimatePresence>;
}

function Pad({ request }: { request: PinRequest }) {
  const setRequest = useLibraryStore((s) => s.setPinRequest);
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(0);
  const [checking, setChecking] = useState(false);
  const present = useIsPresent();

  const type = (d: string) => {
    if (pin.length >= 4 || checking) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) {
      setChecking(true);
      void Promise.resolve(request.check(next))
        .catch(() => false)
        .then((ok) => {
          // The prompt may have been cancelled or replaced while the PIN was being checked.
          setChecking(false);
          if (useLibraryStore.getState().pinRequest !== request) return setPin('');
          if (ok) {
            setRequest(null);
            request.then();
          } else {
            setWrong((w) => w + 1);
            window.setTimeout(() => setPin(''), 350);
          }
        });
    }
  };

  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) type(e.key);
      else if (e.key === 'Backspace') {
        if (!checking) setPin((p) => p.slice(0, -1));
      }
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <FullScreenOverlay
      onClose={() => setRequest(null)}
      label={request.title}
      priority={195}
      className="flex items-center justify-center bg-black/85 backdrop-blur-sm"
    >
      <IconButton onClick={() => setRequest(null)} aria-label="Cancel" size="lg" className="absolute right-8 top-8">
        <X className="h-8 w-8" />
      </IconButton>
      <div className="flex flex-col items-center">
        <Lock className="mb-4 h-8 w-8 text-nf-secondary" />
        <h2 className="text-3xl font-medium">{request.title}</h2>
        {request.subtitle && <p className="mt-2 text-nf-secondary">{request.subtitle}</p>}
        <motion.div key={wrong} animate={wrong ? { x: [0, -12, 12, -8, 8, 0] } : {}} transition={{ duration: 0.35 }} className="my-8 flex gap-4">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`flex h-16 w-14 items-center justify-center border-2 text-3xl ${i === pin.length ? 'border-white' : 'border-white/40'} ${
                wrong && pin.length === 4 ? 'border-nf-red' : ''
              }`}
            >
              {pin[i] ? '•' : ''}
            </span>
          ))}
        </motion.div>
        <div className="grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} onClick={() => type(d)} data-nav-autofocus={d === '1' ? '' : undefined} className="h-14 w-20 rounded bg-white/10 text-2xl font-semibold hover:bg-white/20">
              {d}
            </button>
          ))}
          <span />
          <button onClick={() => type('0')} className="h-14 w-20 rounded bg-white/10 text-2xl font-semibold hover:bg-white/20">
            0
          </button>
          <button onClick={() => !checking && setPin((p) => p.slice(0, -1))} aria-label="Delete" className="flex h-14 w-20 items-center justify-center rounded hover:bg-white/10">
            <Delete className="h-6 w-6" />
          </button>
        </div>
        {wrong > 0 && <p className="mt-6 text-sm text-nf-red">Wrong PIN. Try again.</p>}
      </div>
    </FullScreenOverlay>
  );
}
