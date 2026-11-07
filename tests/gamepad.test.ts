import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPEAT_DELAY_MS, createPadMapper, heldActions, startGamepadLoop, type PadAction } from '../src/lib/gamepad';

function pad({ buttons = [] as number[], axes = [0, 0], values = {} as Record<number, number> } = {}) {
  return {
    connected: true,
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => {
      const value = values[i] ?? (buttons.includes(i) ? 1 : 0);
      return { pressed: buttons.includes(i) || value > 0.5, touched: false, value };
    }),
  } as unknown as Gamepad;
}

describe('button mapping', () => {
  it('maps the standard layout', () => {
    const cases: [number, PadAction][] = [
      [0, 'accept'], [1, 'back'], [2, 'secondary'], [3, 'search'], [4, 'prevTab'], [5, 'nextTab'],
      [9, 'start'], [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right'],
    ];
    for (const [index, action] of cases) expect([...heldActions([pad({ buttons: [index] })])]).toEqual([action]);
  });

  it('applies the stick dead zone and picks the dominant axis', () => {
    expect(heldActions([pad({ axes: [0.3, -0.2] })]).size).toBe(0);
    expect([...heldActions([pad({ axes: [0.9, 0.6] })])]).toEqual(['right']);
    expect([...heldActions([pad({ axes: [-0.2, -0.8] })])]).toEqual(['up']);
  });

  it('needs a real trigger pull before seeking', () => {
    expect(heldActions([pad({ values: { 7: 0.2 } })]).size).toBe(0);
    expect([...heldActions([pad({ values: { 6: 0.8 } })])]).toEqual(['seekBack']);
  });

  it('ignores missing and disconnected pads', () => {
    expect(heldActions([null, { ...pad({ buttons: [0] }), connected: false } as Gamepad]).size).toBe(0);
  });
});

describe('repeat', () => {
  it('fires once, waits, then repeats faster and faster while held', () => {
    const mapper = createPadMapper();
    const held = [pad({ buttons: [15] })];
    const times: number[] = [];
    for (let t = 0; t <= 1500; t += 10) if (mapper.update(held, t).includes('right')) times.push(t);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(REPEAT_DELAY_MS);
    const gaps = times.slice(1).map((t, i) => t - times[i]).slice(1);
    expect(gaps[0]).toBeGreaterThan(gaps.at(-1)!);
    expect(gaps.at(-1)!).toBeGreaterThanOrEqual(60);
  });

  it('never repeats buttons like A', () => {
    const mapper = createPadMapper();
    const held = [pad({ buttons: [0] })];
    const fired = [0, 500, 1000, 2000].flatMap((t) => mapper.update(held, t));
    expect(fired).toEqual(['accept']);
    mapper.update([pad()], 2100);
    expect(mapper.update(held, 2200)).toEqual(['accept']);
  });
});

describe('polling loop', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'getGamepads', original);
    else delete (navigator as { getGamepads?: unknown }).getGamepads;
    vi.unstubAllGlobals();
  });

  it('polls only while a controller is connected and reports actions', () => {
    let pads: (Gamepad | null)[] = [];
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const onAction = vi.fn();
    const onConnect = vi.fn();
    const stop = startGamepadLoop({ onAction, onConnect });
    expect(frames).toHaveLength(0);

    pads = [pad({ buttons: [0] })];
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pads[0] }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    frames.shift()!(0);
    expect(onAction).toHaveBeenCalledWith('accept');

    pads = [];
    frames.shift()!(16);
    // No controllers left: the loop stops scheduling frames.
    expect(frames).toHaveLength(0);
    stop();
  });
});
