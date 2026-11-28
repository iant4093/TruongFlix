/**
 * Play sessions: from when a game's process starts until it (and anything it started from its
 * folder) exits.
 *
 * - Started with Play: Rust waits for the game to exit and reports how long it ran.
 * - Started any other way (its desktop shortcut, its own launcher, Steam-style launchers that
 *   restart it): noticed by a check of the installed games' folders every few seconds, timed
 *   from when the game's first process started, and ended when nothing from its folder runs.
 *
 * Each open session is noted in window storage and checked in on every poll, so closing
 * TruongFlix mid-game doesn't lose it: on the next start a game still running is watched until it
 * exits; one that ended meanwhile is counted up to its last check-in. Time the computer slept
 * (a long gap between check-ins) isn't counted.
 */

export interface OpenSession {
  /** When the game started (ms). */
  start: number;
  /** Last time it was seen running (ms). */
  seen: number;
  /** Seconds counted so far (check-in gaps longer than `MAX_GAP` left out). Older notes lack it. */
  played?: number;
  /** Profile active when it started, so its time shows in that profile's Wrapped. */
  profile?: number | null;
  /** Noticed running rather than started with Play. */
  external?: boolean;
}

export type OpenSessions = Record<string, OpenSession>;

/** A library game the tracker may notice running. */
export interface WatchedGame {
  id: number;
  installDir: string | null;
  /** Installed and not being installed, verified or uninstalled (an uninstaller runs from its folder). */
  playable: boolean;
}

export interface TrackerDeps {
  read(): OpenSessions;
  write(sessions: OpenSessions): void;
  /** For each folder, when the earliest game process running from it started (ms), or null. */
  runningSince(dirs: string[]): Promise<(number | null)[]>;
  credit(gameId: number, seconds: number, profile: number | null, endedAt: Date): Promise<void>;
  setRunning(gameId: number, running: boolean): void;
  now(): number;
  profile(): number | null;
}

export const POLL_MS = 15_000;
/** A longer gap between check-ins means TruongFlix or the computer wasn't running: not counted. */
export const MAX_GAP_MS = 3 * 60_000;

const playedSoFar = (s: OpenSession) => s.played ?? Math.max(0, (s.seen - s.start) / 1000);

export function createSessionTracker(deps: TrackerDeps) {
  /** Games started with Play: Rust times them. */
  const launched = new Set<number>();
  /** Open sessions checked in this run (the others were noted before TruongFlix last closed). */
  const current = new Set<number>();
  /** When each game's last Play session ended (ms). */
  const lastEnd = new Map<number, number>();
  let busy: Promise<void> | null = null;

  /** `continuous`: the same game process ran the whole time, so a long gap was still play. */
  const checkIn = (s: OpenSession, now: number, continuous = false): OpenSession => {
    const gap = now - s.seen;
    return { ...s, played: playedSoFar(s) + (gap > 0 && (continuous || gap <= MAX_GAP_MS) ? gap / 1000 : 0), seen: now };
  };

  async function finish(id: number, entry: OpenSession) {
    deps.setRunning(id, false);
    const seconds = Math.round(playedSoFar(entry));
    if (seconds > 0) await deps.credit(id, seconds, entry.profile ?? null, new Date(entry.seen));
  }

  async function check(games: WatchedGame[]) {
    const byId = new Map(games.map((g) => [g.id, g]));
    // Sessions to look for: every open one Rust isn't timing, and playable games not yet open.
    const before = deps.read();
    const watch = games.filter((g) => g.installDir && !launched.has(g.id) && (before[g.id] || g.playable));
    const since = watch.length ? await deps.runningSince(watch.map((g) => g.installDir!)).catch(() => null) : [];
    if (!since) return; // couldn't look: try again next time rather than end sessions
    // Read again: Play may have been pressed, or a game ended, while the folders were checked.
    const now = deps.now();
    const open = deps.read();
    const running = new Map<number, number | null>();
    watch.forEach((g, i) => {
      // A process from before a session Rust timed ended was part of that session.
      if (!launched.has(g.id)) running.set(g.id, since[i] != null && since[i]! <= (lastEnd.get(g.id) ?? -Infinity) ? null : since[i]);
    });
    const ended: [number, OpenSession][] = [];
    for (const key of Object.keys(open)) {
      const id = Number(key);
      const startedAt = running.get(id);
      if (launched.has(id)) {
        open[key] = checkIn(open[key], now);
      } else if (startedAt != null && !current.has(id) && startedAt > open[key].seen) {
        // Noted before TruongFlix closed, but that game exited and was started again since:
        // the old session ends at its last check-in, the new one is picked up below.
        ended.push([id, open[key]]);
        current.delete(id);
        delete open[key];
      } else if (startedAt != null) {
        // Seen again after TruongFlix restarted: the same process ran all along.
        open[key] = checkIn(open[key], now, !current.has(id));
        current.add(id);
        deps.setRunning(id, true);
      } else if (!byId.get(id)?.installDir || running.has(id)) {
        // Exited (or the game left the library): counted up to its last check-in.
        ended.push([id, open[key]]);
        current.delete(id);
        delete open[key];
      }
    }
    for (const [id, startedAt] of running) {
      if (startedAt == null || open[id]) continue;
      const start = Math.min(startedAt, now);
      open[id] = { start, seen: now, played: Math.max(0, (now - start) / 1000), profile: deps.profile(), external: true };
      current.add(id);
      deps.setRunning(id, true);
    }
    deps.write(open);
    for (const [id, entry] of ended) {
      await finish(id, entry);
      if (open[id]) deps.setRunning(id, true); // started again: a new session is open
    }
  }

  return {
    /** Looks for games starting and ending; one check at a time. */
    poll(games: WatchedGame[]): Promise<void> {
      busy ??= check(games).finally(() => (busy = null));
      return busy;
    },

    /** Play was pressed: Rust times this session until `ended`. Call before starting the game. */
    launching(id: number) {
      launched.add(id);
      const now = deps.now();
      deps.write({ ...deps.read(), [id]: { start: now, seen: now, played: 0, profile: deps.profile() } });
      deps.setRunning(id, true);
    },

    /** Play failed before the game started. */
    launchFailed(id: number) {
      launched.delete(id);
      const open = deps.read();
      delete open[id];
      deps.write(open);
      deps.setRunning(id, false);
    },

    /** Rust saw the game exit after `seconds` of play. */
    async ended(id: number, seconds: number) {
      launched.delete(id);
      lastEnd.set(id, deps.now());
      const open = deps.read();
      const entry = open[id];
      delete open[id];
      deps.write(open);
      deps.setRunning(id, false);
      if (seconds > 0) await deps.credit(id, Math.round(seconds), entry?.profile ?? null, new Date(deps.now()));
    },

    isLaunched: (id: number) => launched.has(id),
  };
}

export type SessionTracker = ReturnType<typeof createSessionTracker>;
