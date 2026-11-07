/**
 * Game controllers via the Gamepad API (standard mapping). Polls with requestAnimationFrame only
 * while a controller is connected and turns button/stick state into actions, with a repeat delay
 * and acceleration for held directions and seek triggers.
 */

export type PadAction =
  | 'up' | 'down' | 'left' | 'right'
  | 'accept' | 'back' | 'secondary' | 'search'
  | 'start' | 'select' | 'prevTab' | 'nextTab'
  | 'seekBack' | 'seekForward';

/** Standard-mapping button indices. */
export const BUTTONS: Partial<Record<PadAction, number[]>> = {
  accept: [0],
  back: [1],
  secondary: [2],
  search: [3],
  prevTab: [4],
  nextTab: [5],
  seekBack: [6],
  seekForward: [7],
  select: [8],
  start: [9],
  up: [12],
  down: [13],
  left: [14],
  right: [15],
};

const REPEATING: ReadonlySet<PadAction> = new Set(['up', 'down', 'left', 'right', 'seekBack', 'seekForward']);

export const STICK_DEADZONE = 0.5;
export const TRIGGER_THRESHOLD = 0.4;
export const REPEAT_DELAY_MS = 400;
export const REPEAT_START_MS = 180;
export const REPEAT_MIN_MS = 60;
const REPEAT_ACCEL = 0.82;

type PadLike = Pick<Gamepad, 'buttons' | 'axes' | 'connected'> | null;

function pressed(pad: NonNullable<PadLike>, index: number) {
  const b = pad.buttons[index];
  if (!b) return false;
  // Analog triggers report a value; use a threshold so a resting trigger never fires.
  return index === 6 || index === 7 ? b.value > TRIGGER_THRESHOLD || (b.pressed && b.value === 0) : b.pressed || b.value > 0.5;
}

/** Which actions are held right now, across every connected controller. */
export function heldActions(pads: readonly PadLike[]): Set<PadAction> {
  const held = new Set<PadAction>();
  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    for (const [action, indices] of Object.entries(BUTTONS) as [PadAction, number[]][]) {
      if (indices.some((i) => pressed(pad, i))) held.add(action);
    }
    const [x = 0, y = 0] = pad.axes;
    // The dominant axis wins, so a diagonal push moves one way only.
    if (Math.max(Math.abs(x), Math.abs(y)) >= STICK_DEADZONE) {
      if (Math.abs(x) >= Math.abs(y)) held.add(x > 0 ? 'right' : 'left');
      else held.add(y > 0 ? 'down' : 'up');
    }
  }
  return held;
}

type Hold = { since: number; next: number; interval: number };

/** Turns successive snapshots into fire-once presses and accelerating repeats. */
export function createPadMapper() {
  const holds = new Map<PadAction, Hold>();
  return {
    update(pads: readonly PadLike[], now: number): PadAction[] {
      const held = heldActions(pads);
      const out: PadAction[] = [];
      for (const action of [...holds.keys()]) if (!held.has(action)) holds.delete(action);
      for (const action of held) {
        const hold = holds.get(action);
        if (!hold) {
          holds.set(action, { since: now, next: now + REPEAT_DELAY_MS, interval: REPEAT_START_MS });
          out.push(action);
        } else if (REPEATING.has(action) && now >= hold.next) {
          out.push(action);
          hold.interval = Math.max(REPEAT_MIN_MS, hold.interval * REPEAT_ACCEL);
          hold.next = now + hold.interval;
        }
      }
      return out;
    },
    reset() {
      holds.clear();
    },
  };
}

export interface GamepadLoopOptions {
  onAction: (action: PadAction) => void;
  onConnect?: (pad: Gamepad) => void;
  onDisconnect?: () => void;
}

const connectedPads = () => (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);

/** Starts listening for controllers. Returns a stop function. */
export function startGamepadLoop({ onAction, onConnect, onDisconnect }: GamepadLoopOptions): () => void {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return () => {};
  const mapper = createPadMapper();
  let frame = 0;
  let running = false;

  const tick = () => {
    const pads = connectedPads();
    if (!pads.length) {
      running = false;
      mapper.reset();
      return;
    }
    for (const action of mapper.update(pads, performance.now())) onAction(action);
    frame = requestAnimationFrame(tick);
  };
  const run = () => {
    if (running) return;
    running = true;
    frame = requestAnimationFrame(tick);
  };
  const connected = (event: GamepadEvent) => {
    onConnect?.(event.gamepad);
    run();
  };
  const disconnected = () => {
    if (!connectedPads().length) onDisconnect?.();
  };

  window.addEventListener('gamepadconnected', connected);
  window.addEventListener('gamepaddisconnected', disconnected);
  if (connectedPads().length) run();

  return () => {
    window.removeEventListener('gamepadconnected', connected);
    window.removeEventListener('gamepaddisconnected', disconnected);
    cancelAnimationFrame(frame);
    running = false;
  };
}
