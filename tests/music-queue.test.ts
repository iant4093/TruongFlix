import { describe, expect, it } from 'vitest';
import * as Q from '../src/music/queue';

/** Deterministic "random" numbers. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};
const ids = (q: Q.QueueState) => q.items.map((i) => i.id);
const now = (q: Q.QueueState) => Q.current(q)?.id ?? null;

describe('music queue', () => {
  it('plays a list from a chosen song', () => {
    const q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3, 4], 2);
    expect(ids(q)).toEqual([1, 2, 3, 4]);
    expect(now(q)).toBe(3);
    expect(Q.upcoming(q).map((i) => i.id)).toEqual([4]);
  });

  it('advances, stops at the end, and wraps with repeat all', () => {
    let q = Q.playList(Q.EMPTY_QUEUE, [1, 2], 0);
    q = Q.next(q, true)!;
    expect(now(q)).toBe(2);
    expect(Q.next(q, true)).toBeNull();
    q = Q.cycleRepeat(q);
    expect(q.repeat).toBe('all');
    expect(now(Q.next(q, true)!)).toBe(1);
  });

  it('repeat one replays the song when it ends, but Next still skips', () => {
    let q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3], 0);
    q = Q.cycleRepeat(Q.cycleRepeat(q));
    expect(q.repeat).toBe('one');
    expect(Q.next(q, true)!.index).toBe(0);
    expect(now(Q.next(q, false)!)).toBe(2);
    expect(Q.cycleRepeat(q).repeat).toBe('off');
  });

  it('previous restarts after 3 seconds, otherwise goes back', () => {
    const q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3], 1);
    expect(Q.previous(q, 10).restart).toBe(true);
    const back = Q.previous(q, 1);
    expect(back.restart).toBe(false);
    expect(now(back.queue)).toBe(1);
    expect(Q.previous(back.queue, 1).restart).toBe(true); // first song: restart
    const wrap = Q.previous({ ...back.queue, repeat: 'all' }, 1);
    expect(now(wrap.queue)).toBe(3);
  });

  it('play next and add to queue', () => {
    let q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3], 0);
    q = Q.playNext(q, [9]);
    q = Q.addToQueue(q, [8, 7]);
    expect(ids(q)).toEqual([1, 9, 2, 3, 8, 7]);
    expect(now(q)).toBe(1);
    // An empty queue starts with what was added.
    const fresh = Q.addToQueue(Q.EMPTY_QUEUE, [5, 6]);
    expect(now(fresh)).toBe(5);
    expect(new Set(q.items.map((i) => i.key)).size).toBe(q.items.length);
  });

  it('reorders and removes without losing the current song', () => {
    let q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3, 4], 1);
    q = Q.move(q, 3, 0);
    expect(ids(q)).toEqual([4, 1, 2, 3]);
    expect(now(q)).toBe(2);
    q = Q.remove(q, 0);
    expect(ids(q)).toEqual([1, 2, 3]);
    expect(now(q)).toBe(2);
    expect(Q.remove(q, q.index)).toBe(q); // the playing song can't be removed
    q = Q.clearUpcoming(q);
    expect(ids(q)).toEqual([1, 2]);
    expect(now(q)).toBe(2);
  });

  it('shuffle keeps the current song first and restores the order when turned off', () => {
    let q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3, 4, 5], 2);
    q = Q.setShuffle(q, true, seq(0, 0, 0, 0));
    expect(q.shuffle).toBe(true);
    expect(now(q)).toBe(3);
    expect(q.index).toBe(0);
    expect([...ids(q)].sort()).toEqual([1, 2, 3, 4, 5]);
    q = Q.addToQueue(q, [6]);
    q = Q.setShuffle(q, false);
    expect(ids(q)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(now(q)).toBe(3);
  });

  it('starting a shuffled list puts the chosen song first', () => {
    const q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3, 4], 3, true, seq(0.5));
    expect(now(q)).toBe(4);
    expect(q.index).toBe(0);
    expect(ids(Q.setShuffle(q, false))).toEqual([1, 2, 3, 4]);
  });

  it('drops songs that left the library', () => {
    let q = Q.playList(Q.EMPTY_QUEUE, [1, 2, 3], 1);
    q = Q.retain(q, (id) => id !== 1 && id !== 2);
    expect(ids(q)).toEqual([2, 3]); // the current song stays
    expect(now(q)).toBe(2);
  });
});
