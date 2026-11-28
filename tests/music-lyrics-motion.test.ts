import { describe, expect, it } from 'vitest';
import { FOLLOW_SPRING, FollowControl, handover, lineLook, staggerMs, stepSpring } from '../src/music/lyricsMotion';

describe('lyrics follow / hand scroll', () => {
  it('follows the song until the user scrolls', () => {
    const f = new FollowControl(3000);
    expect(f.manual).toBe(false);
    expect(f.shouldResume(10_000)).toBe(false);
    expect(f.input(1000)).toBe(true);
    expect(f.manual).toBe(true);
  });

  it('comes back a few seconds after the last scroll, and each scroll restarts the wait', () => {
    const f = new FollowControl(3000);
    f.input(1000);
    expect(f.input(2500)).toBe(false); // already scrolling by hand
    expect(f.shouldResume(3999)).toBe(false);
    expect(f.shouldResume(5499)).toBe(false);
    expect(f.shouldResume(5500)).toBe(true);
    f.resume();
    expect(f.manual).toBe(false);
    expect(f.shouldResume(99_999)).toBe(false);
  });

  it('never comes back while a finger is on the lyrics; the wait starts when it lifts', () => {
    const f = new FollowControl(3000);
    expect(f.touch(1000, 1)).toBe(true);
    expect(f.shouldResume(60_000)).toBe(false);
    f.touch(60_000, 0);
    expect(f.shouldResume(62_000)).toBe(false);
    expect(f.shouldResume(63_000)).toBe(true);
  });

  it('a second finger does not restart the take-over, and lifting one finger keeps waiting', () => {
    const f = new FollowControl(3000);
    f.touch(0, 1);
    expect(f.touch(100, 2)).toBe(false);
    f.touch(200, 1);
    expect(f.shouldResume(10_000)).toBe(false);
    f.touch(10_000, 0);
    expect(f.shouldResume(13_000)).toBe(true);
  });

  it('tapping a line follows again straight away', () => {
    const f = new FollowControl(3000);
    f.touch(0, 1);
    f.touch(50, 0);
    f.resume();
    expect(f.manual).toBe(false);
    expect(f.input(100)).toBe(true);
  });
});

describe('handing over to the browser scroll', () => {
  const drawnAt = (layout: number[], ys: number[], scrollTop: number) => layout.map((l, i) => l + ys[i] - scrollTop);

  it('keeps every line where it is drawn', () => {
    const layout = [0, 60, 120, 180, 240];
    // Following: scrolled to 0, the rows glide up by transforms (the lower ones a beat behind).
    const ys = [-118, -118, -110, -96, -90];
    const before = drawnAt(layout, ys, 0);
    const { scrollTop, shift } = handover(ys, 2, 0, 1000);
    expect(scrollTop).toBe(110);
    const after = drawnAt(
      layout,
      ys.map((y) => y + shift),
      scrollTop,
    );
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]));
    // The current line is then at its own place in the scrolled list: no offset left.
    expect(ys[2] + shift).toBeCloseTo(0);
  });

  it('counts a scroll the browser already made', () => {
    const { scrollTop, shift } = handover([-200, -200], 0, 40, 1000);
    expect(scrollTop).toBe(240);
    expect(shift).toBe(200);
  });

  it('stays inside the scrollable range', () => {
    expect(handover([30], 0, 0, 1000)).toEqual({ scrollTop: 0, shift: 0 });
    expect(handover([-5000], 0, 0, 800)).toEqual({ scrollTop: 800, shift: 800 });
  });
});

describe('lyric springs', () => {
  const run = (fps: number, seconds: number) => {
    const s = { y: 0, v: 0 };
    let peak = 0;
    for (let t = 0; t < seconds; t += 1 / fps) {
      stepSpring(s, -100, 1 / fps, FOLLOW_SPRING);
      peak = Math.min(peak, s.y);
    }
    return { s, peak };
  };

  it('glides to the new line and comes to rest there', () => {
    const { s, peak } = run(60, 2);
    expect(s.y).toBe(-100);
    expect(s.v).toBe(0);
    expect(peak).toBeGreaterThan(-104); // lands softly, no visible bounce
  });

  it('moves the same at 60 and 144 fps', () => {
    const a = { y: 0, v: 0 };
    const b = { y: 0, v: 0 };
    for (let i = 0; i < 18; i++) stepSpring(a, -100, 1 / 60, FOLLOW_SPRING);
    for (let i = 0; i < 43; i++) stepSpring(b, -100, 1 / 144, FOLLOW_SPRING);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1.5);
  });

  it('carries its speed into a new goal instead of jerking', () => {
    const s = { y: 0, v: 0 };
    for (let i = 0; i < 10; i++) stepSpring(s, -100, 1 / 60, FOLLOW_SPRING);
    const v = s.v;
    stepSpring(s, -200, 1 / 60, FOLLOW_SPRING);
    expect(Math.sign(s.v)).toBe(Math.sign(v));
    expect(Math.abs(s.v - v)).toBeLessThan(Math.abs(v));
  });

  it('starts lines below later, capped, and not at all with reduced motion', () => {
    expect(staggerMs(-3)).toBe(0);
    expect(staggerMs(0)).toBe(0);
    expect(staggerMs(2)).toBeGreaterThan(staggerMs(1));
    expect(staggerMs(40)).toBe(staggerMs(8));
    expect(staggerMs(3, true)).toBe(0);
  });

  it('on a move down (seek back) the lines above trail instead, so lines never run into each other', () => {
    expect(staggerMs(3, false, false)).toBe(0);
    expect(staggerMs(-3, false, false)).toBe(staggerMs(3));
    // Each line sets off no later than the one behind it in the direction of travel.
    for (let d = -10; d < 10; d++) {
      expect(staggerMs(d)).toBeLessThanOrEqual(staggerMs(d + 1));
      expect(staggerMs(d, false, false)).toBeGreaterThanOrEqual(staggerMs(d + 1, false, false));
    }
  });
});

describe('line look', () => {
  it('fades and blurs with distance from the current line', () => {
    const at = (d: number) => lineLook(d);
    expect(at(0)).toEqual({ opacity: 1, blur: 0, scale: 1 });
    expect(at(1).opacity).toBeGreaterThan(at(3).opacity);
    expect(at(1).blur).toBeLessThan(at(3).blur);
    expect(at(-1).opacity).toBeLessThan(at(1).opacity); // sung lines a little dimmer
    expect(at(40).blur).toBe(0); // far off screen
  });

  it('is sharp while scrolling by hand, without blur where it is off, flat with reduced motion', () => {
    expect(lineLook(3, { manual: true }).blur).toBe(0);
    expect(lineLook(3, { blur: false }).blur).toBe(0);
    expect(lineLook(3, { reduce: true }).scale).toBe(1);
  });
});
