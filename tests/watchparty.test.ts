import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HARD_DRIFT_S, MAX_NUDGE, syncDecision, type TogetherState, type TogetherTitle } from '../src/remote/together';
import { TogetherClient, type TogetherPlayer, type TogetherTransport } from '../src/remote/togetherClient';
import { MAX_HOLD_MS, STALE_MS, WatchParties, type MemberInfo } from '../src/services/watchparty';

const titles: Record<string, { label: string; certification: string | null }> = {
  'movie:1': { label: 'Grown-up film', certification: 'R' },
  'movie:2': { label: 'Family film', certification: 'G' },
  'episode:7': { label: 'Show · S1:E2 · Pilot', certification: 'TV-MA' },
};

let now = 1_000_000;
const clock = () => now;
const lookup = vi.fn(async (t: TogetherTitle) => titles[`${t.type}:${t.id}`] ?? null);
let seed = 0;
const parties = () => new WatchParties({ now: clock, random: () => (seed = (seed + 0.137) % 1), lookup });

const ian: MemberInfo = { id: 'b:ian', name: 'Ian', device: 'iPhone · Safari', kind: 'browser', profile: { id: 1, maturity: 'all' } };
const mai: MemberInfo = { id: 'desktop', name: 'Mai', device: 'PC app', kind: 'desktop', profile: { id: 4, maturity: 'all' } };
const kid: MemberInfo = { id: 'b:kid', name: 'Kids', device: 'iPad · Safari', kind: 'browser', profile: { id: 2, maturity: 'kids' } };

beforeEach(() => {
  now = 1_000_000;
});

describe('watch party rooms', () => {
  it('creates a room with a short code, lets others join by code and ends when everyone leaves', async () => {
    const p = parties();
    const created = await p.create(ian, { type: 'movie', id: 2 }, { position: 30, playing: true });
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(created).toMatchObject({ label: 'Family film', playing: true, position: 30, waitForAll: true });
    expect(created.members).toEqual([expect.objectContaining({ id: 'b:ian', name: 'Ian', device: 'iPhone · Safari', host: true, you: true })]);

    now += 5000;
    const joined = await p.join(created.code.toLowerCase(), mai);
    expect(joined.members.map((m) => [m.name, m.you])).toEqual([['Ian', false], ['Mai', true]]);
    // The newcomer is loading, so the room waits for them (wait-for-everyone is on).
    expect(joined).toMatchObject({ held: true, position: 35 });

    const seen = p.poll('b:ian', created.code, { since: created.seq });
    expect(seen.events.map((e) => e.text)).toEqual(['Mai · PC app joined', 'Waiting for Mai']);
    expect((await p.list(ian.profile)).map((r) => r.members)).toEqual([['Ian · iPhone · Safari', 'Mai · PC app']]);

    await expect(p.join('ZZZZZZ', kid)).rejects.toMatchObject({ status: 404 });

    p.leave('b:ian');
    const after = p.poll('desktop', created.code, { since: seen.seq });
    expect(after.members.map((m) => [m.name, m.host])).toEqual([['Mai', true]]);
    expect(after.events.map((e) => e.text)).toEqual(['Ian · iPhone · Safari left']);
    p.leave('desktop');
    expect(await p.list(ian.profile)).toEqual([]);
    expect(() => p.poll('desktop', created.code)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('turns play, pause, seek and speed changes into room events with an exact clock', async () => {
    const p = parties();
    const room = await p.create(ian, { type: 'movie', id: 2 }, { position: 0, playing: true });
    await p.join(room.code, mai);
    p.poll('desktop', room.code, { buffering: false });

    now += 10_000;
    expect(p.poll('b:ian', room.code).position).toBeCloseTo(10);
    const paused = await p.act('desktop', room.code, 'pause', { position: 9.5 }, room.seq);
    expect(paused).toMatchObject({ playing: false, position: 9.5 });
    now += 5000;
    expect(p.poll('b:ian', room.code).position).toBe(9.5);

    const sought = await p.act('b:ian', room.code, 'seek', { position: 120 });
    expect(sought.position).toBe(120);
    await p.act('b:ian', room.code, 'rate', { rate: 2 });
    await p.act('b:ian', room.code, 'play', {});
    now += 3000;
    const s = p.poll('desktop', room.code, { since: paused.seq - 1 });
    expect(s.position).toBeCloseTo(126);
    expect(s.events.map((e) => [e.kind, e.text])).toEqual([
      ['pause', 'Mai paused'],
      ['seek', 'Ian jumped to 2:00'],
      ['rate', 'Ian set the speed to 2×'],
      ['play', 'Ian resumed'],
    ]);
    await expect(p.act('b:ian', room.code, 'seek', {})).rejects.toMatchObject({ status: 400 });
    await expect(p.act('b:kid', room.code, 'pause', {})).rejects.toMatchObject({ status: 404 });
  });

  it('pauses everyone while someone buffers, unless “wait for everyone” is off', async () => {
    const p = parties();
    const room = await p.create(ian, { type: 'movie', id: 2 }, { position: 100, playing: true });
    await p.join(room.code, mai);
    now += 4000;
    // Still loading: the clock is frozen at the join.
    expect(p.poll('b:ian', room.code)).toMatchObject({ held: true, position: 100 });
    p.poll('desktop', room.code, { buffering: false });
    now += 2000;
    expect(p.poll('b:ian', room.code)).toMatchObject({ held: false, position: 102 });

    p.poll('desktop', room.code, { buffering: true });
    now += 3000;
    expect(p.poll('b:ian', room.code)).toMatchObject({ held: true, position: 102 });
    await p.act('b:ian', room.code, 'wait', { on: false });
    now += 1000;
    expect(p.poll('b:ian', room.code)).toMatchObject({ held: false, waitForAll: false, position: 103 });

    // Someone stuck loading doesn't hold the room forever.
    await p.act('b:ian', room.code, 'wait', { on: true });
    expect(p.poll('b:ian', room.code).held).toBe(true);
    for (let waited = 0; waited <= MAX_HOLD_MS; waited += 5000) {
      now += 5000;
      p.poll('desktop', room.code, { buffering: true });
      p.poll('b:ian', room.code);
    }
    expect(p.poll('b:ian', room.code).held).toBe(false);
  });

  it('drops participants that stop polling and ends rooms nobody polls', async () => {
    const p = parties();
    const room = await p.create(ian, { type: 'movie', id: 2 });
    await p.join(room.code, mai);
    now += STALE_MS - 1000;
    p.poll('b:ian', room.code);
    now += 2000;
    const s = p.poll('b:ian', room.code, { since: room.seq + 2 });
    expect(s.members.map((m) => m.name)).toEqual(['Ian']);
    expect(s.events.map((e) => e.text)).toEqual(['Mai · PC app dropped out']);
    expect(s.held).toBe(false);
    now += STALE_MS + 1;
    expect(await p.list(ian.profile)).toEqual([]);
  });

  it('refuses profiles that may not watch the title, and hides those rooms from them', async () => {
    const p = parties();
    await expect(p.create(kid, { type: 'movie', id: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(p.create(ian, { type: 'movie', id: 99 })).rejects.toMatchObject({ status: 403 });
    const grownUp = await p.create(ian, { type: 'movie', id: 1 });
    await expect(p.join(grownUp.code, kid)).rejects.toMatchObject({ status: 403 });
    expect(await p.list(kid.profile)).toEqual([]);

    const family = await p.create(mai, { type: 'movie', id: 2 });
    expect((await p.list(kid.profile)).map((r) => r.code)).toEqual([family.code]);
    await p.join(family.code, kid);
    // Switching the room to a title the kid can't watch removes them from it.
    const switched = await p.act('desktop', family.code, 'title', { title: { type: 'episode', id: 7 } });
    expect(switched).toMatchObject({ label: 'Show · S1:E2 · Pilot', position: 0, title: { type: 'episode', id: 7 } });
    expect(switched.members.map((m) => m.name)).toEqual(['Mai']);
    expect(switched.events.map((e) => e.text)).toContain('Kids · iPad · Safari can’t watch this title');
    await expect(p.act('b:kid', family.code, 'title', { title: { type: 'movie', id: 2 } })).rejects.toMatchObject({ status: 404 });
  });

  it('keeps each participant in one room at a time', async () => {
    const p = parties();
    const a = await p.create(ian, { type: 'movie', id: 2 });
    const b = await p.create(mai, { type: 'movie', id: 1 });
    await p.join(b.code, ian);
    // Ian's old room had only Ian, so it ended.
    await expect(p.join(a.code, mai)).rejects.toMatchObject({ status: 404 });
    expect(p.poll('b:ian', b.code).members).toHaveLength(2);
    expect(() => p.poll('b:ian', a.code)).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('drift decisions', () => {
  const room = { position: 100, playing: true, rate: 1 };

  it('seeks when more than 1.5 s off', () => {
    expect(syncDecision({ position: 100 + HARD_DRIFT_S + 0.1, playing: true }, room)).toMatchObject({ seek: 100, rate: 1 });
    expect(syncDecision({ position: 97, playing: true }, room).seek).toBe(100);
  });

  it('nudges the speed silently for small drift and leaves tiny drift alone', () => {
    const ahead = syncDecision({ position: 101, playing: true }, room);
    expect(ahead.seek).toBeUndefined();
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeGreaterThanOrEqual(1 - MAX_NUDGE);
    const behind = syncDecision({ position: 99.4, playing: true }, { ...room, rate: 2 });
    expect(behind.rate).toBeGreaterThan(2);
    expect(syncDecision({ position: 100.1, playing: true }, room)).toEqual({ rate: 1, drift: expect.closeTo(0.1) });
  });

  it('follows play / pause and lines up exactly while paused', () => {
    expect(syncDecision({ position: 100, playing: true }, { ...room, playing: false })).toMatchObject({ play: false });
    expect(syncDecision({ position: 100.8, playing: false }, { ...room, playing: false }).seek).toBe(100);
    expect(syncDecision({ position: 100, playing: false }, room)).toMatchObject({ play: true });
  });
});

describe('participant sync loop', () => {
  function setup(initial: Partial<{ position: number; playing: boolean; buffering: boolean; title: TogetherTitle }> = {}) {
    const local = { position: 0, playing: false, buffering: false, rate: 1, title: { type: 'movie', id: 2 } as TogetherTitle, ...initial };
    const calls: string[] = [];
    const player: TogetherPlayer = {
      title: () => local.title,
      position: () => local.position,
      playing: () => local.playing,
      buffering: () => local.buffering,
      rate: () => local.rate,
      play: () => {
        calls.push('play');
        local.playing = true;
      },
      pause: () => {
        calls.push('pause');
        local.playing = false;
      },
      seek: (t) => {
        calls.push(`seek ${t}`);
        local.position = t;
      },
      setRate: (r) => {
        calls.push(`rate ${r.toFixed(3)}`);
        local.rate = r;
      },
      switchTitle: (t, pos) => calls.push(`switch ${t.type}:${t.id}@${pos}`),
    };
    const p = parties();
    const transport: TogetherTransport = {
      poll: async (code, r) => p.poll('desktop', code, r),
      act: vi.fn((code, action, value, since) => p.act('desktop', code, action, value, since)),
      leave: async () => p.leave('desktop'),
    };
    const events: string[] = [];
    const ended: (string | null)[] = [];
    const client = new TogetherClient(transport, player, { onState: () => {}, onEvent: (e) => events.push(e.text), onEnded: (r) => ended.push(r) }, clock, () => null);
    return { local, calls, p, transport, client, events, ended };
  }

  it('follows the room and reports only the user’s own changes', async () => {
    const t = setup();
    const room = await t.p.create(ian, { type: 'movie', id: 2 }, { position: 50, playing: true });
    t.client.start(await t.p.join(room.code, mai));
    // Held for us while we load: pause at the room's position.
    expect(t.calls).toEqual(['seek 50']);
    t.calls.length = 0;
    now += 4000; // past the settle window after joining
    await t.client.tick();
    expect(t.calls).toEqual(['play']);
    // Our own play echoes back from the player: not reported.
    t.client.localPlaying(true);
    expect(t.transport.act).not.toHaveBeenCalled();

    // Ian pauses: we follow and get a toast.
    now += 2500;
    t.local.position = 52.5;
    await t.p.act('b:ian', room.code, 'pause', { position: 52.5 });
    t.calls.length = 0;
    await t.client.tick();
    expect(t.calls).toEqual(['pause']);
    expect(t.events).toContain('Ian paused');

    // The user here resumes and seeks: both become room events.
    now += 3000;
    t.local.playing = true;
    t.client.localPlaying(true);
    expect(t.transport.act).toHaveBeenLastCalledWith(room.code, 'play', { position: 52.5 }, expect.any(Number));
    await Promise.resolve();
    t.local.position = 300;
    t.client.localSeek();
    expect(t.transport.act).toHaveBeenLastCalledWith(room.code, 'seek', { position: 300 }, expect.any(Number));
  });

  it('nudges speed for small drift and switches title to join a room on another title', async () => {
    const t = setup({ position: 10, playing: true, title: { type: 'movie', id: 1 } });
    const room = await t.p.create(ian, { type: 'movie', id: 2 }, { position: 40, playing: true });
    t.client.start(await t.p.join(room.code, mai));
    expect(t.calls).toEqual(['switch movie:2@40']);
    t.local.title = { type: 'movie', id: 2 };
    t.local.position = 40.8;
    t.client.localTitle(t.local.title);
    expect(t.transport.act).not.toHaveBeenCalled();
    t.calls.length = 0;
    // Loaded: the room runs again; a little later we're 0.8 s ahead.
    t.p.poll('desktop', room.code, { buffering: false });
    t.p.poll('b:ian', room.code);
    now += 3500;
    t.local.position = 44.3;
    await t.client.tick();
    expect(t.calls).toEqual([expect.stringMatching(/^rate 0\.9\d\d$/)]);
    // The nudge's ratechange is not a user speed change.
    t.client.localRate(t.local.rate);
    expect(t.transport.act).not.toHaveBeenCalled();
  });

  it('ends when the room drops this participant', async () => {
    const t = setup();
    const room = await t.p.create(ian, { type: 'movie', id: 2 });
    t.client.start(await t.p.join(room.code, mai));
    t.p.leave('desktop');
    await t.client.tick();
    expect(t.ended).toEqual(['You’re not in this watch party any more']);
    expect(t.client.state).toBeNull();
  });
});
