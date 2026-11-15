/**
 * "Watch together": types shared by the desktop room host and every participant (browser players
 * and the desktop's built-in player), plus the pure timing rules each participant follows.
 * Only timing is shared; every participant keeps its own stream and quality.
 */

export type TogetherTitle = { type: 'movie' | 'episode'; id: number };
export type TogetherAction = 'play' | 'pause' | 'seek' | 'rate' | 'title' | 'wait';
export type TogetherEventKind = 'join' | 'leave' | 'play' | 'pause' | 'seek' | 'rate' | 'title' | 'wait' | 'buffering';

export interface TogetherMember {
  id: string;
  /** Profile name. */
  name: string;
  /** e.g. "iPhone · Safari" or "TruongFlix on Den PC". */
  device: string;
  kind: 'browser' | 'desktop';
  buffering: boolean;
  host: boolean;
  you: boolean;
}

export interface TogetherEvent {
  seq: number;
  kind: TogetherEventKind;
  member: string;
  text: string;
  at: number;
}

/** A room as one participant sees it. `position` is where playback is at `serverTime`. */
export interface TogetherState {
  code: string;
  title: TogetherTitle;
  label: string;
  playing: boolean;
  /** Paused for everyone while a participant buffers ("wait for everyone"). */
  held: boolean;
  position: number;
  rate: number;
  serverTime: number;
  waitForAll: boolean;
  members: TogetherMember[];
  /** Events after the `since` the participant asked for. */
  events: TogetherEvent[];
  seq: number;
}

export interface TogetherRoomSummary {
  code: string;
  label: string;
  title: TogetherTitle;
  members: string[];
}

/** Off by more than this many seconds: seek to the room. */
export const HARD_DRIFT_S = 1.5;
/** Smaller drift than this is ignored; between this and HARD_DRIFT_S the speed is nudged. */
export const SOFT_DRIFT_S = 0.25;
/** Largest silent speed change used to catch up (5%). */
export const MAX_NUDGE = 0.05;
/** While paused, line up exactly once off by more than this. */
export const PAUSED_DRIFT_S = 0.5;
/** How often participants poll the room. */
export const POLL_MS = 1000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Whether the room's clock is running (playing and not held for a buffering participant). */
export const running = (s: Pick<TogetherState, 'playing' | 'held'>) => s.playing && !s.held;

/** Where the room is `elapsedMs` after its snapshot was taken. */
export function projectPosition(s: Pick<TogetherState, 'playing' | 'held' | 'position' | 'rate'>, elapsedMs: number) {
  return running(s) ? s.position + (Math.max(0, elapsedMs) / 1000) * s.rate : s.position;
}

export interface SyncDecision {
  /** Start (true) or pause (false) local playback. */
  play?: boolean;
  /** Seek local playback to this position. */
  seek?: number;
  /** Playback speed to use (the room's rate, nudged slightly to absorb small drift). */
  rate: number;
  /** Local minus room position, in seconds (positive = ahead). */
  drift: number;
}

/** What a participant should do to follow the room. */
export function syncDecision(local: { position: number; playing: boolean }, room: { position: number; playing: boolean; rate: number }): SyncDecision {
  const drift = local.position - room.position;
  const out: SyncDecision = { rate: room.rate, drift };
  if (local.playing !== room.playing) out.play = room.playing;
  const size = Math.abs(drift);
  if (size > HARD_DRIFT_S || (!room.playing && size > PAUSED_DRIFT_S)) out.seek = Math.max(0, room.position);
  else if (room.playing && size > SOFT_DRIFT_S) out.rate = room.rate * (1 - clamp(drift * 0.1, -MAX_NUDGE, MAX_NUDGE));
  return out;
}

/**
 * Tells a participant's own commands apart from the user's: changes the sync loop makes are
 * expected for a short while, so their player events aren't reported back as room events.
 */
export class Echoes {
  private until = new Map<string, number>();
  constructor(private now: () => number = () => Date.now()) {}
  expect(kind: 'play' | 'pause' | 'seek' | 'rate', ms = 2000) {
    this.until.set(kind, this.now() + ms);
  }
  /** True while a change of `kind` made by the sync loop is still expected. */
  pending(kind: 'play' | 'pause' | 'seek' | 'rate') {
    return (this.until.get(kind) ?? 0) >= this.now();
  }
  clear() {
    this.until.clear();
  }
}

/** Display name for a member: "Ian · iPhone · Safari". */
export const memberLabel = (m: Pick<TogetherMember, 'name' | 'device'>) => (m.device ? `${m.name} · ${m.device}` : m.name);
