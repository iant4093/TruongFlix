import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionTracker, MAX_GAP_MS, type OpenSessions, type WatchedGame } from '../src/games/sessions';

const MIN = 60_000;
const T0 = Date.parse('2026-11-27T18:00:00.000Z');

/** A tracker with a clock, window storage and process list the test controls. */
function setup(stored: OpenSessions = {}) {
  const state = {
    now: T0,
    storage: JSON.stringify(stored),
    /** Install folder → when its game's first process started (absent: not running). */
    processes: new Map<string, number>(),
    failLookups: false,
    running: new Map<number, boolean>(),
    credits: [] as { id: number; seconds: number; profile: number | null; endedAt: string }[],
    profile: 2 as number | null,
  };
  const tracker = createSessionTracker({
    read: () => JSON.parse(state.storage) as OpenSessions,
    write: (v) => void (state.storage = JSON.stringify(v)),
    runningSince: async (dirs) => {
      if (state.failLookups) throw new Error('no access');
      return dirs.map((d) => state.processes.get(d) ?? null);
    },
    credit: async (id, seconds, profile, endedAt) => void state.credits.push({ id, seconds, profile, endedAt: endedAt.toISOString() }),
    setRunning: (id, running) => void state.running.set(id, running),
    now: () => state.now,
    profile: () => state.profile,
  });
  const open = () => JSON.parse(state.storage) as OpenSessions;
  return { state, tracker, open };
}

const trees: WatchedGame = { id: 1, installDir: 'D:\\Games\\Trees', playable: true };
const rocks: WatchedGame = { id: 2, installDir: 'D:\\Games\\Rocks', playable: true };
const iso = (ms: number) => new Date(ms).toISOString();
/** Polls once a minute for `minutes` (TruongFlix polls every few seconds). */
async function playFor(ctx: ReturnType<typeof setup>, games: WatchedGame[], minutes: number) {
  for (let i = 0; i < minutes; i++) {
    ctx.state.now += MIN;
    await ctx.tracker.poll(games);
  }
}

describe('sessions started with Play', () => {
  it('are timed by the game exiting, for the profile that started it', async () => {
    const { state, tracker, open } = setup();
    tracker.launching(1);
    expect(state.running.get(1)).toBe(true);
    expect(open()[1]).toMatchObject({ start: T0, profile: 2 });
    state.now += 90 * MIN;
    state.profile = 5; // switching profile mid-game doesn't move the session
    await tracker.ended(1, 5400);
    expect(state.credits).toEqual([{ id: 1, seconds: 5400, profile: 2, endedAt: iso(T0 + 90 * MIN) }]);
    expect(open()).toEqual({});
    expect(state.running.get(1)).toBe(false);
  });

  it('are not counted twice by the folder check while Rust times them', async () => {
    const { state, tracker } = setup();
    tracker.launching(1);
    state.processes.set(trees.installDir!, T0 + 1000);
    await tracker.poll([trees]);
    state.now += 30 * MIN;
    await tracker.poll([trees]);
    await tracker.ended(1, 1800);
    // The game's helper is still closing: it belongs to the session that just ended.
    await tracker.poll([trees]);
    expect(state.credits.map((c) => c.seconds)).toEqual([1800]);
    expect(state.running.get(1)).toBe(false);
  });

  it('drop their note when the game fails to start', () => {
    const { state, tracker, open } = setup();
    tracker.launching(1);
    tracker.launchFailed(1);
    expect(open()).toEqual({});
    expect(state.running.get(1)).toBe(false);
  });

  it('keep the note Play just made when a folder check was already under way', async () => {
    const { state, tracker, open } = setup();
    const polling = tracker.poll([trees]);
    tracker.launching(1); // pressed while the process list was being read
    await polling;
    expect(open()[1]).toMatchObject({ start: T0, profile: 2 });
    expect(state.running.get(1)).toBe(true);
  });
});

describe('games started outside TruongFlix', () => {
  it('are timed from when their process started until it exits', async () => {
    const { state, tracker, open } = setup();
    await tracker.poll([trees, rocks]);
    expect(open()).toEqual({});

    // Started from its desktop shortcut two minutes before the check noticed.
    state.processes.set(trees.installDir!, T0 + 3 * MIN);
    state.now = T0 + 5 * MIN;
    await tracker.poll([trees, rocks]);
    expect(open()[1]).toMatchObject({ start: T0 + 3 * MIN, external: true, profile: 2 });
    expect(state.running.get(1)).toBe(true);
    expect(state.running.has(2)).toBe(false);

    for (let t = 6; t <= 65; t++) {
      state.now = T0 + t * MIN;
      await tracker.poll([trees, rocks]);
    }
    state.processes.delete(trees.installDir!);
    state.now = T0 + 66 * MIN;
    await tracker.poll([trees, rocks]);
    // 3 → 65 min: last seen running at 65.
    expect(state.credits).toEqual([{ id: 1, seconds: 62 * 60, profile: 2, endedAt: iso(T0 + 65 * MIN) }]);
    expect(open()).toEqual({});
    expect(state.running.get(1)).toBe(false);
  });

  it('are not noticed while the game is being installed, verified or uninstalled', async () => {
    const { state, tracker, open } = setup();
    state.processes.set(trees.installDir!, T0); // unins000.exe runs from the game's folder
    await tracker.poll([{ ...trees, playable: false }]);
    expect(open()).toEqual({});
    expect(state.credits).toEqual([]);
  });

  it("don't count time the computer slept", async () => {
    const ctx = setup();
    const { state, tracker } = ctx;
    state.processes.set(trees.installDir!, T0);
    await tracker.poll([trees]);
    await playFor(ctx, [trees], 10);
    state.now = T0 + 10 * MIN + MAX_GAP_MS + 8 * 60 * MIN; // overnight asleep
    await tracker.poll([trees]);
    state.now += MIN;
    await tracker.poll([trees]);
    state.processes.delete(trees.installDir!);
    state.now += MIN;
    await tracker.poll([trees]);
    expect(state.credits.map((c) => c.seconds)).toEqual([11 * 60]);
  });

  it("aren't ended when the process list can't be read", async () => {
    const { state, tracker, open } = setup();
    state.processes.set(trees.installDir!, T0);
    await tracker.poll([trees]);
    state.failLookups = true;
    state.now += MIN;
    await tracker.poll([trees]);
    expect(open()[1]).toBeDefined();
    expect(state.credits).toEqual([]);
  });

  it('end when the game leaves the library', async () => {
    const ctx = setup();
    const { state, tracker, open } = ctx;
    state.processes.set(trees.installDir!, T0);
    await tracker.poll([trees]);
    await playFor(ctx, [trees], 10);
    state.now += MIN;
    await tracker.poll([]);
    expect(state.credits.map((c) => c.seconds)).toEqual([600]);
    expect(open()).toEqual({});
  });
});

describe('closing TruongFlix mid-session', () => {
  // Noted by the previous run: started at T0, last checked in at T0 + 20 min.
  const stored: OpenSessions = { 1: { start: T0, seen: T0 + 20 * MIN, played: 20 * 60, profile: 3 } };

  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(structuredClone(stored)); });

  it('keeps counting a game still running when TruongFlix opens again', async () => {
    const { state, tracker } = ctx;
    state.processes.set(trees.installDir!, T0 + 2000); // the same process
    state.now = T0 + 2 * 60 * MIN; // reopened two hours later
    await tracker.poll([trees]);
    expect(state.running.get(1)).toBe(true);
    state.now += MIN;
    await tracker.poll([trees]);
    state.processes.delete(trees.installDir!);
    state.now += MIN;
    await tracker.poll([trees]);
    expect(state.credits).toEqual([{ id: 1, seconds: 121 * 60, profile: 3, endedAt: iso(T0 + 121 * MIN) }]);
  });

  it('counts a game that ended while TruongFlix was closed up to its last check-in', async () => {
    const { state, tracker, open } = ctx;
    state.now = T0 + 5 * 60 * MIN;
    await tracker.poll([trees]);
    expect(state.credits).toEqual([{ id: 1, seconds: 20 * 60, profile: 3, endedAt: iso(T0 + 20 * MIN) }]);
    expect(open()).toEqual({});
  });

  it('ends the old session and starts a new one when the game was started again meanwhile', async () => {
    const { state, tracker, open } = ctx;
    state.processes.set(trees.installDir!, T0 + 60 * MIN);
    state.now = T0 + 90 * MIN;
    await tracker.poll([trees]);
    expect(state.credits).toEqual([{ id: 1, seconds: 20 * 60, profile: 3, endedAt: iso(T0 + 20 * MIN) }]);
    expect(open()[1]).toMatchObject({ start: T0 + 60 * MIN, external: true });
    expect(state.running.get(1)).toBe(true);
  });

  it('reads notes left by older versions (no played seconds)', async () => {
    const { state, tracker } = setup({ 1: { start: T0, seen: T0 + 15 * MIN, profile: null } });
    state.now = T0 + 60 * MIN;
    await tracker.poll([trees]);
    expect(state.credits).toEqual([{ id: 1, seconds: 15 * 60, profile: null, endedAt: iso(T0 + 15 * MIN) }]);
  });
});
