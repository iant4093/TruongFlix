/**
 * The synced lyrics' motion, apart from the DOM so it can be tested: springs that glide each line
 * into place, the stagger that gives the scroll its ripple, how the lines look by distance from
 * the current one, and when following the song pauses for a hand scroll and comes back.
 */

/** How long the lyrics wait after the last hand scroll (or touch) before following the song again. */
export const FOLLOW_IDLE_MS = 3000;

/** Follows the song unless the user is scrolling; picks it up again once they've left it alone. */
export class FollowControl {
  manual = false;
  private lastInput = -Infinity;
  private fingers = 0;

  constructor(readonly idleMs = FOLLOW_IDLE_MS) {}

  /** A wheel, key or scroll by the user. True when it just took over from following. */
  input(now: number): boolean {
    const took = !this.manual;
    this.manual = true;
    this.lastInput = now;
    return took;
  }

  /** Fingers on the lyrics (from touch events). Following never comes back while one is down. */
  touch(now: number, fingers: number): boolean {
    const was = this.fingers;
    this.fingers = Math.max(0, fingers);
    if (this.fingers > was) return this.input(now);
    if (this.manual) this.lastInput = now; // the wait starts when the last finger lifts
    return false;
  }

  /** Time to glide back to the current line. */
  shouldResume(now: number): boolean {
    return this.manual && this.fingers === 0 && now - this.lastInput >= this.idleMs;
  }

  /** Following again (after the wait, or a line was tapped to seek). */
  resume(): void {
    this.manual = false;
    this.fingers = 0;
    this.lastInput = -Infinity;
  }
}

export interface SpringState {
  y: number;
  v: number;
}

export interface SpringConfig {
  stiffness: number;
  damping: number;
}

/** Following the song: a soft glide, a touch under-damped so it lands without a hard stop. */
export const FOLLOW_SPRING: SpringConfig = { stiffness: 130, damping: 21 };
/** Taken over by hand: lines still mid-glide settle quickly into the list the user is scrolling. */
export const SETTLE_SPRING: SpringConfig = { stiffness: 620, damping: 50 };

const STEP = 1 / 240;

/**
 * Moves a spring towards `goal` by `dt` seconds (in small steps, so it behaves the same at any
 * frame rate). Velocity carries over when the goal changes mid-glide, so a new line never jerks.
 * Returns false once it has come to rest on the goal.
 */
export function stepSpring(s: SpringState, goal: number, dt: number, { stiffness, damping }: SpringConfig): boolean {
  let left = Math.max(0, dt);
  while (left > 1e-9) {
    const h = Math.min(left, STEP);
    const a = -stiffness * (s.y - goal) - damping * s.v;
    s.v += a * h;
    s.y += s.v * h;
    left -= h;
  }
  if (Math.abs(s.y - goal) < 0.05 && Math.abs(s.v) < 0.5) {
    s.y = goal;
    s.v = 0;
    return false;
  }
  return true;
}

/**
 * How long (ms) a line waits before setting off for a new current line, which gives the scroll its
 * ripple. The lines trailing the move wait, each a beat after the one ahead of it: the lines below
 * when the lyrics move up (the song goes on), the lines above when they move down (a seek back).
 * Leading lines always go first, so lines spread apart for a moment and never run into each other.
 */
export function staggerMs(distance: number, reduce = false, movingUp = true): number {
  const behind = movingUp ? distance : -distance;
  if (reduce || behind <= 0) return 0;
  return Math.min(behind, 8) * 42;
}

/** Rows further than this from the current line are off screen: not blurred or layer-promoted. */
export const NEAR_ABOVE = 8;
export const NEAR_BELOW = 16;

const BLUR = [0, 0.7, 1.25, 1.65, 1.95, 2.2];

/** How a line looks `distance` lines from the current one: brightest and sharpest in the middle. */
export function lineLook(distance: number, { manual = false, blur = true, reduce = false } = {}): { opacity: number; blur: number; scale: number } {
  const d = Math.abs(distance);
  if (d === 0) return { opacity: 1, blur: 0, scale: 1 };
  const scale = reduce ? 1 : 0.965;
  // Scrolling by hand: every line readable, the current one still stands out.
  if (manual) return { opacity: 0.5, blur: 0, scale };
  const near = distance < 0 ? d <= NEAR_ABOVE : d <= NEAR_BELOW;
  const opacity = distance < 0 ? Math.max(0.16, 0.34 - 0.045 * (d - 1)) : Math.max(0.2, 0.46 - 0.06 * (d - 1));
  return { opacity: Math.round(opacity * 1000) / 1000, blur: blur && near ? BLUR[Math.min(d, BLUR.length - 1)] : 0, scale };
}

/**
 * Taking over from following. While following, the list's scroll position stays put (`scrollTop`)
 * and the rows are drawn `ys[i]` px off their place by transforms. To hand over to the browser's
 * own scrolling without anything moving, scroll to where the anchor row is drawn and move every
 * row's offset by the same amount. Returns the scroll position and that shift.
 */
export function handover(ys: number[], anchor: number, scrollTop: number, maxScroll: number): { scrollTop: number; shift: number } {
  const drawn = scrollTop - (ys[anchor] ?? 0);
  const next = Math.min(Math.max(0, drawn), Math.max(0, maxScroll));
  return { scrollTop: next, shift: next - scrollTop };
}
