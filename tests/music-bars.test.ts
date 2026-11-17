import { describe, expect, it } from 'vitest';
import { createBarMeter } from '../src/music/analyser';

describe('now-playing bar meter', () => {
  it('does not sit at the top when a band is loud all the time', () => {
    const meter = createBarMeter(1);
    let h = [0];
    // Steady loud bass with a slight wobble, for ~5 s of frames.
    for (let f = 0; f < 300; f++) h = meter([0.9 + 0.02 * Math.sin(f / 3)]);
    expect(h[0]).toBeLessThan(0.75);
  });

  it('jumps on a beat and falls back after it', () => {
    const meter = createBarMeter(1);
    for (let f = 0; f < 120; f++) meter([0.4 + (f % 30 === 0 ? 0.4 : 0)]);
    const quiet = meter([0.4])[0];
    let beat = 0;
    for (let f = 0; f < 3; f++) beat = meter([0.85])[0];
    let after = beat;
    for (let f = 0; f < 30; f++) after = meter([0.4])[0];
    expect(beat).toBeGreaterThan(0.7);
    expect(quiet).toBeLessThan(0.3);
    expect(after).toBeLessThan(0.3);
  });

  it('keeps each band separate', () => {
    const meter = createBarMeter(5);
    let h: number[] = [];
    for (let f = 0; f < 120; f++) h = meter([0.9, 0.5, 0.3, f % 20 < 3 ? 0.6 : 0.2, 0.1]);
    expect(h).toHaveLength(5);
    for (const v of h) expect(v).toBeGreaterThanOrEqual(0);
  });
});
