import {
  Echoes,
  HARD_DRIFT_S,
  POLL_MS,
  projectPosition,
  running,
  syncDecision,
  type TogetherAction,
  type TogetherEvent,
  type TogetherState,
  type TogetherTitle,
} from './together';

/**
 * One participant of a watch party: polls the room, makes the local player follow it, and turns
 * the local user's play / pause / seek / speed / title changes into room events. Used by the
 * browser player (over `/api/together/…`) and the desktop player (calling the rooms directly).
 */

export interface TogetherTransport {
  poll(code: string, report: { buffering: boolean; since: number }): Promise<TogetherState>;
  act(code: string, action: TogetherAction, value: { position?: number; rate?: number; on?: boolean; title?: TogetherTitle }, since: number): Promise<TogetherState>;
  leave(code: string): Promise<unknown>;
}

/** The local player, seen through the few things the sync loop needs. */
export interface TogetherPlayer {
  /** Current title, or null while nothing is loaded. */
  title(): TogetherTitle | null;
  /** Absolute position in seconds. */
  position(): number;
  playing(): boolean;
  /** Loading, seeking or waiting for data. */
  buffering(): boolean;
  rate(): number;
  play(): void;
  pause(): void;
  seek(position: number): void;
  setRate(rate: number): void;
  /** Load another title at `position` (the room moved on, or this participant just joined). */
  switchTitle(title: TogetherTitle, position: number, label: string): void;
}

export interface TogetherCallbacks {
  onState(state: TogetherState | null): void;
  /** Something another participant did ("Ian paused"). */
  onEvent(event: TogetherEvent): void;
  /** The party ended for this participant (left, dropped or refused), with a reason to show. */
  onEnded(reason: string | null): void;
}

const sameTitle = (a: TogetherTitle | null, b: TogetherTitle | null) => !!a && !!b && a.type === b.type && a.id === b.id;
/** Local changes right after a (re)load are the player settling, not the user. */
const SETTLE_MS = 3000;

export class TogetherClient {
  state: TogetherState | null = null;
  private receivedAt = 0;
  private latency = 0;
  private since = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private stopped = false;
  private echoes: Echoes;
  private requested: string | null = null;
  private settleUntil = 0;
  private appliedRate = 1;

  constructor(
    private transport: TogetherTransport,
    private player: TogetherPlayer,
    private cb: TogetherCallbacks,
    private now: () => number = () => Date.now(),
    private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> | null = (fn, ms) => setTimeout(fn, ms),
  ) {
    this.echoes = new Echoes(now);
  }

  get code() {
    return this.state?.code ?? null;
  }

  /** Begins following a room returned by create / join. */
  start(state: TogetherState) {
    this.stopped = false;
    this.since = state.seq;
    this.accept(state, 0);
    this.loop();
  }

  private loop() {
    if (this.stopped) return;
    this.timer = this.schedule(() => {
      void this.tick().finally(() => this.loop());
    }, POLL_MS);
  }

  /** One poll: report buffering, get the room, follow it. */
  async tick() {
    const code = this.code;
    if (!code || this.inflight || this.stopped) return;
    this.inflight = true;
    const sent = this.now();
    try {
      const s = await this.transport.poll(code, { buffering: this.player.buffering(), since: this.since });
      if (!this.stopped) this.accept(s, this.now() - sent);
    } catch (e) {
      this.fail(e);
    } finally {
      this.inflight = false;
    }
  }

  private fail(e: unknown) {
    const status = (e as { status?: number })?.status;
    if (status === 404 || status === 401) this.end(e instanceof Error ? e.message : 'The watch party ended');
    else if (status === 403) this.end(e instanceof Error ? e.message : 'You can’t watch this');
    // Anything else (a dropped request) is retried on the next poll.
  }

  private end(reason: string | null) {
    this.stop();
    this.state = null;
    this.cb.onState(null);
    this.cb.onEnded(reason);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async leave() {
    const code = this.code;
    this.stop();
    this.state = null;
    this.cb.onState(null);
    if (code) await this.transport.leave(code).catch(() => {});
  }

  /** Where the room is right now, from the last snapshot. */
  roomPosition() {
    const s = this.state;
    if (!s) return 0;
    return projectPosition(s, this.now() - this.receivedAt + this.latency / 2);
  }

  private accept(s: TogetherState, rtt: number) {
    this.state = s;
    this.receivedAt = this.now();
    this.latency = Math.min(2000, Math.max(0, rtt));
    for (const e of s.events) {
      if (e.seq <= this.since) continue;
      const mine = s.members.find((m) => m.you)?.id;
      if (e.member !== mine) this.cb.onEvent(e);
    }
    this.since = Math.max(this.since, s.seq);
    this.cb.onState(s);
    this.follow();
  }

  /** Makes the local player match the room. */
  follow() {
    const s = this.state;
    if (!s || this.stopped) return;
    const current = this.player.title();
    if (!sameTitle(current, s.title)) {
      const key = `${s.title.type}:${s.title.id}`;
      if (this.requested !== key) {
        this.requested = key;
        this.settle();
        this.player.switchTitle(s.title, this.roomPosition(), s.label);
      }
      return;
    }
    this.requested = null;
    // Still loading (just joined, or our last seek): the room waits for us, or we catch up once ready.
    if (this.player.buffering() && (this.echoes.pending('seek') || this.settling())) return;
    const room = { position: this.roomPosition(), playing: running(s), rate: s.rate };
    const d = syncDecision({ position: this.player.position(), playing: this.player.playing() }, room);
    if (d.play === true) {
      this.echoes.expect('play');
      this.player.play();
    } else if (d.play === false) {
      this.echoes.expect('pause');
      this.player.pause();
    }
    if (d.seek != null) {
      this.echoes.expect('seek');
      this.player.seek(d.seek);
    }
    if (Math.abs(this.player.rate() - d.rate) > 0.004) {
      this.appliedRate = d.rate;
      this.player.setRate(d.rate);
    }
  }

  /** Call when the local player (re)loads media: its first events aren't user actions. */
  settle() {
    this.settleUntil = this.now() + SETTLE_MS;
  }

  private settling() {
    return this.now() < this.settleUntil;
  }

  private async send(action: TogetherAction, value: { position?: number; rate?: number; on?: boolean; title?: TogetherTitle }) {
    const code = this.code;
    if (!code) return;
    try {
      const s = await this.transport.act(code, action, value, this.since);
      if (!this.stopped) this.accept(s, 0);
    } catch (e) {
      this.fail(e);
    }
  }

  /** The local player started or stopped playing. */
  localPlaying(playing: boolean) {
    const s = this.state;
    if (!s || this.settling() || this.echoes.pending(playing ? 'play' : 'pause')) return;
    if (playing === running(s)) return;
    void this.send(playing ? 'play' : 'pause', { position: this.player.position() });
  }

  /** The local player finished a seek. */
  localSeek() {
    const s = this.state;
    if (!s || this.settling() || this.echoes.pending('seek')) return;
    const position = this.player.position();
    if (Math.abs(position - this.roomPosition()) <= HARD_DRIFT_S) return;
    void this.send('seek', { position });
  }

  /** The local player's speed changed. Our own small catch-up nudges are ignored. */
  localRate(rate: number) {
    const s = this.state;
    if (!s || this.settling()) return;
    if (Math.abs(rate - this.appliedRate) <= 0.06 || Math.abs(rate - s.rate) < 0.001) return;
    this.appliedRate = rate;
    void this.send('rate', { rate });
  }

  /** The local player moved to another title (e.g. next episode): the room follows. */
  localTitle(title: TogetherTitle | null) {
    const s = this.state;
    if (!s || !title) return;
    this.settle();
    if (sameTitle(title, s.title) || this.requested === `${title.type}:${title.id}`) return;
    void this.send('title', { title, position: 0 });
  }

  setWaitForAll(on: boolean) {
    void this.send('wait', { on });
  }
}
