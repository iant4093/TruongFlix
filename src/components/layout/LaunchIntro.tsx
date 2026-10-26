import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const LETTERS = 'TRUONGFLIX'.split('');
const TOTAL_MS = 2700;
let soundPlayed = false; // once per launch (effects can run twice in development)

/** Original sound: a rising noise swell, two deep hits, then a shimmering chord (all synthesized). */
function playIntroSound() {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  void ctx.resume().catch(() => {});
  const t0 = ctx.currentTime + 0.05;
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);

  // Swell: filtered noise rising into the first hit.
  const noise = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const swell = ctx.createBufferSource();
  swell.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(300, t0);
  bp.frequency.exponentialRampToValueAtTime(2400, t0 + 0.55);
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0.0001, t0);
  sg.gain.exponentialRampToValueAtTime(0.25, t0 + 0.5);
  sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
  swell.connect(bp).connect(sg).connect(master);
  swell.start(t0);
  swell.stop(t0 + 0.7);

  // Two hits: pitch-dropping sines with a click.
  for (const [at, level] of [
    [0.55, 0.8],
    [0.85, 1],
  ] as const) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(130, t0 + at);
    osc.frequency.exponentialRampToValueAtTime(38, t0 + at + 0.35);
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(level, t0 + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.6);
    osc.connect(g).connect(master);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.65);
  }

  // Chord bloom: detuned saws through an opening low-pass.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(200, t0 + 0.9);
  lp.frequency.exponentialRampToValueAtTime(3200, t0 + 1.6);
  lp.frequency.exponentialRampToValueAtTime(600, t0 + 2.7);
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.0001, t0 + 0.9);
  cg.gain.exponentialRampToValueAtTime(0.16, t0 + 1.3);
  cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8);
  lp.connect(cg).connect(master);
  for (const f of [110, 164.81, 220, 261.63, 329.63]) {
    for (const detune of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(lp);
      o.start(t0 + 0.9);
      o.stop(t0 + 2.9);
    }
  }
  window.setTimeout(() => void ctx.close().catch(() => {}), 3500);
}

/** Short animated intro shown once at launch; click or press any key to skip. */
export default function LaunchIntro({ sound, onDone }: { sound: boolean; onDone: () => void }) {
  const [visible, setVisible] = useState(true);
  const done = useRef(onDone);
  done.current = onDone;
  const streaks = useMemo(
    () =>
      Array.from({ length: 46 }, (_, i) => ({
        left: 50 + (Math.random() - 0.5) * 22,
        hue: [0, 350, 340, 320, 290, 10][i % 6],
        light: 45 + Math.random() * 20,
        width: 0.25 + Math.random() * 0.9,
        delay: Math.random() * 0.25,
      })),
    [],
  );

  useEffect(() => {
    if (sound && !soundPlayed) {
      soundPlayed = true;
      try {
        playIntroSound();
      } catch {
        /* audio may be blocked; the animation still plays */
      }
    }
    const t = window.setTimeout(() => setVisible(false), TOTAL_MS);
    // Never leave the overlay up if the exit animation can't run (e.g. hidden window).
    const failsafe = window.setTimeout(() => done.current(), TOTAL_MS + 2000);
    const skip = () => setVisible(false);
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('mousedown', skip, { once: true });
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(failsafe);
      window.removeEventListener('keydown', skip);
      window.removeEventListener('mousedown', skip);
    };
  }, [sound]);

  return (
    <AnimatePresence onExitComplete={() => done.current()}>
      {visible && (
        <motion.div
          key="intro"
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
          className="fixed inset-0 z-[300] flex items-center justify-center overflow-hidden bg-black"
        >
          {/* Light streaks that burst out as the logo zooms past the camera */}
          <motion.div
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: [0, 0, 1, 0], scale: [0.4, 0.4, 1.6, 3] }}
            transition={{ duration: 2.1, times: [0, 0.42, 0.7, 1], ease: 'easeIn' }}
          >
            {streaks.map((s, i) => (
              <motion.span
                key={i}
                className="absolute top-0 h-full"
                style={{
                  left: `${s.left}%`,
                  width: `${s.width}vw`,
                  background: `linear-gradient(180deg, transparent, hsl(${s.hue} 90% ${s.light}%) 35%, hsl(${s.hue} 95% ${s.light + 15}%) 50%, hsl(${s.hue} 90% ${s.light}%) 65%, transparent)`,
                  filter: 'blur(1px)',
                }}
                initial={{ scaleY: 0, x: 0 }}
                animate={{ scaleY: [0, 1, 1], x: `${(s.left - 50) * 4}vw` }}
                transition={{ duration: 1.2, delay: 0.85 + s.delay, ease: 'easeOut' }}
              />
            ))}
          </motion.div>

          <motion.div
            className="relative"
            initial={{ scale: 0.82 }}
            animate={{ scale: [0.82, 1, 1.05, 14], opacity: [1, 1, 1, 0] }}
            transition={{ duration: 2.2, times: [0, 0.35, 0.5, 1], ease: [0.5, 0, 0.75, 0] }}
          >
            <span className="nf-wordmark text-[clamp(3rem,9vw,9rem)]" style={{ filter: 'drop-shadow(0 0 24px rgba(229,9,20,0.75))' }}>
              {LETTERS.map((ch, i) => {
                const d = Math.abs(i - 4.5) / 4.5;
                return (
                  <motion.span
                    key={i}
                    initial={{ opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.06 + i * 0.035, duration: 0.35 }}
                  >
                    <span className="inline-block" style={{ transform: `scaleY(${(1.12 + 0.2 * d * d).toFixed(3)})` }}>
                      {ch}
                    </span>
                  </motion.span>
                );
              })}
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
