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
      analyser.smoothingTimeConstant = 0.6;
      // A wider range than the default (-100…-30 dB), so loud bass doesn't sit at the top.
      analyser.minDecibels = -85;
      analyser.maxDecibels = -12;
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

/** Five bands from bass to treble, each 0…1. Null when there's nothing to read (no analyser, or silence). */
export function musicLevels(): number[] | null {
  if (!analyser || !bins) return null;
  analyser.getByteFrequencyData(bins);
  // 64 bins of ~350 Hz at 44.1/48 kHz: bass, low mids, mids, high mids and highs (wider going up,
  // roughly how we hear pitch).
  const band = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += bins![i];
    return sum / ((to - from) * 255);
  };
  const levels = [band(0, 1), band(1, 3), band(3, 7), band(7, 14), band(14, 32)];
  return levels.some((v) => v > 0.01) ? levels : null;
}

/**
 * Turns band levels into bar heights (0…1), one call per frame. Each bar is scaled between its band's
 * recent quiet and loud points, so it moves with the beat rather than sitting at the top whenever a
 * band is loud all the time (bass usually is). Quick to rise, slower to fall.
 */
export function createBarMeter(count: number) {
  const floor = new Array<number>(count).fill(1);
  const ceil = new Array<number>(count).fill(0);
  const shown = new Array<number>(count).fill(0);
  return (levels: number[]): number[] =>
    shown.map((prev, i) => {
      const v = levels[i] ?? 0;
      // The quiet point drops at once and creeps back up; the loud point jumps up and fades.
      floor[i] = v < floor[i] ? v : floor[i] + (v - floor[i]) * 0.02;
      ceil[i] = v > ceil[i] ? v : ceil[i] + (v - ceil[i]) * 0.01;
      const range = Math.max(ceil[i] - floor[i], 0.08);
      const target = Math.min(1, Math.max(0, (v - floor[i]) / range)) ** 1.4;
      shown[i] = target > prev ? prev + (target - prev) * 0.6 : prev * 0.82 + target * 0.18;
      return shown[i];
    });
}

export const analyserActive = () => !!analyser && !failed;
