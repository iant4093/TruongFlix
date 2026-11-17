/**
 * Live levels of the music for the now-playing bars (desktop app only). The audio elements are
 * routed through one Web Audio analyser; the browser app doesn't do this, because audio going
 * through Web Audio stops when a phone locks.
 *
 * The music comes from the PC's media server, which sends CORS headers, so the audio elements load
 * it with `crossOrigin = "anonymous"` and the analyser can read it.
 */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let bins: Uint8Array<ArrayBuffer> | null = null;
const wired = new WeakSet<HTMLMediaElement>();
let failed = false;

/**
 * Routes the elements through the analyser. Call from a click or key press (browsers start audio
 * contexts only then); safe to call on every play. The audio is only rerouted once the context is
 * actually running, so music started without a click (a media key) still plays, just without levels.
 */
export function connectAnalyser(elements: HTMLMediaElement[]) {
  if (failed) return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('No Web Audio');
    if (!ctx) {
      ctx = new Ctor();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.72;
      analyser.connect(ctx.destination);
      bins = new Uint8Array(analyser.frequencyBinCount);
    }
    const wire = () => {
      if (ctx?.state !== 'running') return;
      for (const el of elements) {
        if (wired.has(el)) continue;
        ctx.createMediaElementSource(el).connect(analyser!);
        wired.add(el);
      }
    };
    if (ctx.state === 'running') wire();
    else void ctx.resume().then(wire, () => {});
  } catch (e) {
    // Without the analyser the bars keep their simple animation; the music plays as before.
    failed = true;
    console.warn('[music] visualizer unavailable', e);
  }
}

/** Wakes the audio context after the system suspended it (call when playback starts). */
export function resumeAnalyser() {
  if (ctx?.state === 'suspended') void ctx.resume();
}

/** Bass, mid and treble, each 0…1. Null when there's nothing to read (no analyser, or silence). */
export function musicLevels(): [number, number, number] | null {
  if (!analyser || !bins) return null;
  analyser.getByteFrequencyData(bins);
  // 64 bins of ~350 Hz at 44.1/48 kHz: bass, mids and highs.
  const band = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += bins![i];
    return sum / ((to - from) * 255);
  };
  const levels: [number, number, number] = [band(0, 2), band(2, 10), band(10, 32)];
  return levels.some((v) => v > 0.01) ? levels : null;
}

export const analyserActive = () => !!analyser && !failed;
