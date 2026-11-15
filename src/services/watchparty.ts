import type { MediaItem, Maturity, Profile } from '../types/media';
import type { TogetherAction, TogetherEvent, TogetherEventKind, TogetherMember, TogetherRoomSummary, TogetherState, TogetherTitle } from '../remote/together';
import { memberLabel } from '../remote/together';
import { allowedForMaturity } from '../store/selectors';
import { formatClock } from '../lib/format';
import * as db from './db';
import { ApiError, rateLimit, type Caller } from './remotecontrol';

/**
 * "Watch together" rooms, hosted by the desktop app. Browsers reach them through `/api/together/…`
 * (see `togetherRoute`); the desktop's own player uses the shared `parties` instance directly.
 * A room only shares timing (title, playing, position at a server timestamp, rate).
 */

/** Participants that haven't polled for this long are dropped. */
export const STALE_MS = 10_000;
/** A participant buffering longer than this no longer holds everyone up. */
export const MAX_HOLD_MS = 20_000;
export const MAX_ROOMS = 16;
export const MAX_MEMBERS = 10;
const KEEP_EVENTS = 40;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** Who is joining: a signed-in browser or the desktop app, watching as a profile. */
export interface MemberInfo {
  id: string;
  name: string;
  device: string;
  kind: 'browser' | 'desktop';
  profile: { id: number; maturity: Maturity };
}

interface Member extends MemberInfo {
  lastSeen: number;
  buffering: boolean;
  bufferingSince: number;
}

interface Room {
  code: string;
  title: TogetherTitle;
  label: string;
  playing: boolean;
  held: boolean;
  position: number;
  at: number;
  rate: number;
  waitForAll: boolean;
  host: string;
  members: Map<string, Member>;
  events: TogetherEvent[];
  seq: number;
}

export interface TitleInfo {
  label: string;
  certification: string | null;
}

export interface PartyOptions {
  now?: () => number;
  random?: () => number;
  /** The title's display label and rating, or null when it doesn't exist. */
  lookup: (title: TogetherTitle) => Promise<TitleInfo | null>;
}

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export class WatchParties {
  private rooms = new Map<string, Room>();
  private now: () => number;
  private random: () => number;
  private lookup: PartyOptions['lookup'];

  constructor(opts: PartyOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32);
    this.lookup = opts.lookup;
  }

  /** Whether `profile` may watch the title (exists and within its maturity rating). */
  async allowed(profile: MemberInfo['profile'], title: TogetherTitle): Promise<TitleInfo | null> {
    if (!Number.isFinite(title.id)) return null;
    const info = await this.lookup(title);
    if (!info || !allowedForMaturity({ certification: info.certification || null } as MediaItem, profile.maturity)) return null;
    return info;
  }

  private position(room: Room, t = this.now()) {
    return room.playing && !room.held ? room.position + ((t - room.at) / 1000) * room.rate : room.position;
  }

  private anchor(room: Room) {
    const t = this.now();
    room.position = Math.max(0, this.position(room, t));
    room.at = t;
  }

  private event(room: Room, kind: TogetherEventKind, member: Member | MemberInfo, text: string) {
    room.events.push({ seq: ++room.seq, kind, member: member.id, text, at: this.now() });
    if (room.events.length > KEEP_EVENTS) room.events.splice(0, room.events.length - KEEP_EVENTS);
  }

  /** Recomputes "held" (someone buffering with wait-for-everyone on), keeping the clock exact. */
  private updateHold(room: Room, cause?: Member) {
    const t = this.now();
    const waiting = [...room.members.values()].find((m) => m.buffering && t - m.bufferingSince < MAX_HOLD_MS);
    const held = room.waitForAll && room.playing && !!waiting;
    if (held === room.held) return;
    this.anchor(room);
    room.held = held;
    const who = waiting ?? cause;
    if (held && who) this.event(room, 'buffering', who, `Waiting for ${who.name}`);
  }

  private code() {
    for (;;) {
      let c = '';
      for (let i = 0; i < CODE_LENGTH; i++) c += CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length) % CODE_CHARS.length];
      if (!this.rooms.has(c)) return c;
    }
  }

  private roomOf(memberId: string) {
    for (const room of this.rooms.values()) if (room.members.has(memberId)) return room;
    return undefined;
  }

  private remove(room: Room, memberId: string, how: 'left' | 'dropped out' | 'can’t watch this title') {
    const m = room.members.get(memberId);
    if (!m) return;
    room.members.delete(memberId);
    if (!room.members.size) {
      this.rooms.delete(room.code);
      return;
    }
    if (room.host === memberId) room.host = room.members.keys().next().value!;
    this.event(room, 'leave', m, `${memberLabel(m)} ${how}`);
    this.updateHold(room);
  }

  /** Drops participants that stopped polling; rooms end when their last participant goes. */
  sweep() {
    const t = this.now();
    for (const room of [...this.rooms.values()]) {
      for (const m of [...room.members.values()]) if (t - m.lastSeen > STALE_MS) this.remove(room, m.id, 'dropped out');
      if (room.members.size) this.updateHold(room);
    }
  }

  private member(info: MemberInfo): Member {
    return { ...info, profile: { id: info.profile.id, maturity: info.profile.maturity }, lastSeen: this.now(), buffering: true, bufferingSince: this.now() };
  }

  private mine(memberId: string, code: unknown) {
    this.sweep();
    const room = this.roomOf(memberId);
    if (!room || (code != null && code !== '' && String(code).toUpperCase() !== room.code)) throw new ApiError(404, 'You’re not in this watch party any more');
    const m = room.members.get(memberId)!;
    m.lastSeen = this.now();
    return { room, m };
  }

  /** Starts a room for a title at the creator's current position. */
  async create(info: MemberInfo, title: TogetherTitle, start: { position?: number; playing?: boolean; rate?: number } = {}): Promise<TogetherState> {
    this.sweep();
    const meta = await this.allowed(info.profile, title);
    if (!meta) throw new ApiError(403, 'Your profile can’t watch this title');
    const existing = this.roomOf(info.id);
    if (existing) this.remove(existing, info.id, 'left');
    if (this.rooms.size >= MAX_ROOMS) throw new ApiError(429, 'Too many watch parties are open right now');
    const m = this.member(info);
    m.buffering = false;
    const room: Room = {
      code: this.code(),
      title: { type: title.type, id: title.id },
      label: meta.label,
      playing: start.playing ?? true,
      held: false,
      position: Math.max(0, finite(start.position) ?? 0),
      at: this.now(),
      rate: Math.min(4, Math.max(0.25, finite(start.rate) ?? 1)),
      waitForAll: true,
      host: info.id,
      members: new Map([[info.id, m]]),
      events: [],
      seq: 0,
    };
    this.rooms.set(room.code, room);
    this.event(room, 'join', m, `${memberLabel(m)} started a watch party`);
    return this.view(room, info.id, room.seq);
  }

  /** Joins by code. Refused when the joiner's profile can't watch the room's title. */
  async join(code: string, info: MemberInfo): Promise<TogetherState> {
    this.sweep();
    const room = this.rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) throw new ApiError(404, 'No watch party with that code');
    if (!(await this.allowed(info.profile, room.title))) throw new ApiError(403, 'Your profile can’t watch what this party is watching');
    if (!this.rooms.has(room.code)) throw new ApiError(404, 'That watch party just ended');
    const already = room.members.get(info.id);
    if (!already) {
      const existing = this.roomOf(info.id);
      if (existing) this.remove(existing, info.id, 'left');
      if (room.members.size >= MAX_MEMBERS) throw new ApiError(429, 'This watch party is full');
    }
    const m = already ?? this.member(info);
    m.lastSeen = this.now();
    if (!already) {
      room.members.set(info.id, m);
      this.event(room, 'join', m, `${memberLabel(m)} joined`);
      this.updateHold(room, m);
    }
    return this.view(room, info.id, room.seq);
  }

  leave(memberId: string) {
    const room = this.roomOf(memberId);
    if (room) this.remove(room, memberId, 'left');
  }

  /** Heartbeat + room state. `since` is the last event seq the participant has seen. */
  poll(memberId: string, code: unknown, report: { buffering?: boolean; since?: number } = {}): TogetherState {
    const { room, m } = this.mine(memberId, code);
    const buffering = !!report.buffering;
    if (buffering !== m.buffering) {
      m.buffering = buffering;
      m.bufferingSince = this.now();
      this.updateHold(room, m);
    }
    return this.view(room, memberId, finite(report.since) ?? room.seq);
  }

  /** A participant's play / pause / seek / speed / title change, applied for everyone. */
  async act(memberId: string, code: unknown, action: TogetherAction, value: { position?: number; rate?: number; title?: TogetherTitle; on?: boolean } = {}, since?: number): Promise<TogetherState> {
    const { room, m } = this.mine(memberId, code);
    const position = finite(value.position);
    const seen = finite(since) ?? room.seq;
    switch (action) {
      case 'play':
      case 'pause': {
        this.anchor(room);
        if (position != null) room.position = Math.max(0, position);
        const playing = action === 'play';
        if (room.playing !== playing) {
          room.playing = playing;
          this.event(room, action, m, `${m.name} ${playing ? 'resumed' : 'paused'}`);
        }
        // A play press means the presser is ready, even if a buffering report is late.
        if (playing) m.buffering = false;
        room.held = false;
        this.updateHold(room, m);
        break;
      }
      case 'seek': {
        if (position == null) throw new ApiError(400, 'Missing position');
        this.anchor(room);
        room.position = Math.max(0, position);
        this.event(room, 'seek', m, `${m.name} jumped to ${formatClock(room.position)}`);
        break;
      }
      case 'rate': {
        const rate = finite(value.rate);
        if (rate == null) throw new ApiError(400, 'Missing speed');
        this.anchor(room);
        room.rate = Math.min(4, Math.max(0.25, rate));
        this.event(room, 'rate', m, `${m.name} set the speed to ${room.rate}×`);
        break;
      }
      case 'wait': {
        this.anchor(room);
        room.waitForAll = !!value.on;
        this.event(room, 'wait', m, `${m.name} turned ${room.waitForAll ? 'on' : 'off'} “wait for everyone”`);
        this.updateHold(room, m);
        break;
      }
      case 'title': {
        const title = value.title;
        if (!title || (title.type !== 'movie' && title.type !== 'episode')) throw new ApiError(400, 'Missing title');
        const meta = await this.allowed(m.profile, title);
        if (!meta) throw new ApiError(403, 'Your profile can’t watch this title');
        if (!this.rooms.has(room.code)) throw new ApiError(404, 'That watch party just ended');
        room.title = { type: title.type, id: Number(title.id) };
        room.label = meta.label;
        room.position = Math.max(0, position ?? 0);
        room.at = this.now();
        room.held = false;
        this.event(room, 'title', m, `${m.name} started ${meta.label}`);
        // Participants whose profile can't watch the new title leave the room.
        for (const other of [...room.members.values()]) {
          if (other.id === m.id) continue;
          if (!(await this.allowed(other.profile, room.title))) {
            this.remove(room, other.id, 'can’t watch this title');
          } else {
            // They're about to load the new title.
            other.buffering = true;
            other.bufferingSince = this.now();
          }
        }
        this.updateHold(room, m);
        break;
      }
      default:
        throw new ApiError(400, 'Unknown action');
    }
    return this.view(room, memberId, seen);
  }

  /** Open rooms whose title the profile may watch. */
  async list(profile: MemberInfo['profile']): Promise<TogetherRoomSummary[]> {
    this.sweep();
    const out: TogetherRoomSummary[] = [];
    for (const room of this.rooms.values()) {
      if (!(await this.allowed(profile, room.title))) continue;
      out.push({ code: room.code, label: room.label, title: { ...room.title }, members: [...room.members.values()].map((m) => memberLabel(m)) });
    }
    return out;
  }

  /** The room the member is in, if any (without counting as a poll). */
  current(memberId: string) {
    const room = this.roomOf(memberId);
    return room ? room.code : null;
  }

  private view(room: Room, memberId: string, since: number): TogetherState {
    const t = this.now();
    const members: TogetherMember[] = [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      device: m.device,
      kind: m.kind,
      buffering: m.buffering,
      host: m.id === room.host,
      you: m.id === memberId,
    }));
    return {
      code: room.code,
      title: { ...room.title },
      label: room.label,
      playing: room.playing,
      held: room.held,
      position: Math.max(0, this.position(room, t)),
      rate: room.rate,
      serverTime: t,
      waitForAll: room.waitForAll,
      members,
      events: room.events.filter((e) => e.seq > since),
      seq: room.seq,
    };
  }
}

/** Label and rating of a movie or episode, read from just that row. */
export async function lookupTitle(title: TogetherTitle): Promise<TitleInfo | null> {
  const conn = await db.getDb();
  if (title.type === 'movie') {
    const rows = await conn.select<{ title: string; certification: string | null }[]>('SELECT title, certification FROM movies WHERE id = $1', [title.id]);
    return rows.length ? { label: rows[0].title, certification: rows[0].certification } : null;
  }
  const rows = await conn.select<{ title: string; season_number: number; episode_number: number; show: string; certification: string | null }[]>(
    'SELECT e.title, e.season_number, e.episode_number, s.title AS show, s.certification FROM episodes e JOIN tv_series s ON s.id = e.series_id WHERE e.id = $1',
    [title.id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { label: `${r.show} · S${r.season_number}:E${r.episode_number} · ${r.title}`, certification: r.certification };
}

/** The rooms of this app session. */
export const parties = new WatchParties({ lookup: lookupTitle });

const memberFor = (caller: Caller, profile: Profile): MemberInfo => ({
  id: `b:${caller.session}`,
  name: profile.name,
  device: caller.device,
  kind: 'browser',
  profile: { id: profile.id, maturity: profile.maturity },
});

const titleOf = (body: Record<string, unknown>): TogetherTitle => ({ type: body.type === 'episode' ? 'episode' : 'movie', id: Number(body.id) });

/** `/api/together/…` for browsers. Returns undefined for paths it doesn't handle. */
export async function togetherRoute(
  caller: Caller,
  method: string,
  path: string,
  query: Record<string, string>,
  body: Record<string, unknown>,
  profile: () => Profile,
): Promise<unknown> {
  const id = `b:${caller.session}`;
  const since = body.since != null ? Number(body.since) : undefined;
  if (method === 'POST' && path === '/together/poll') {
    rateLimit(caller, 'together-poll', 40, 10_000);
    return parties.poll(id, body.code, { buffering: !!body.buffering, since });
  }
  if (method === 'POST' && path === '/together/report') {
    rateLimit(caller, 'together-report', 30, 10_000);
    const action = String(body.action ?? '') as TogetherAction;
    const value = {
      position: body.position != null ? Number(body.position) : undefined,
      rate: body.rate != null ? Number(body.rate) : undefined,
      on: body.on != null ? !!body.on : undefined,
      title: action === 'title' ? titleOf(body) : undefined,
    };
    if (action === 'title') profile(); // the reporter's profile must still be unlocked
    return parties.act(id, body.code, action, value, since);
  }
  if (method === 'POST' && path === '/together/leave') {
    parties.leave(id);
    return { ok: true };
  }
  if (method === 'GET' && path === '/together/rooms') {
    rateLimit(caller, 'together-rooms', 20, 10_000);
    const p = profile();
    return parties.list({ id: p.id, maturity: p.maturity });
  }
  if (method === 'POST' && path === '/together/create') {
    rateLimit(caller, 'together-join', 10, 60_000);
    return parties.create(memberFor(caller, profile()), titleOf(body), {
      position: body.position != null ? Number(body.position) : undefined,
      playing: body.playing != null ? !!body.playing : undefined,
      rate: body.rate != null ? Number(body.rate) : undefined,
    });
  }
  if (method === 'POST' && path === '/together/join') {
    rateLimit(caller, 'together-join', 10, 60_000);
    return parties.join(String(body.code ?? query.code ?? ''), memberFor(caller, profile()));
  }
  return undefined;
}
