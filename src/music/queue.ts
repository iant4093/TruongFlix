/**
 * The play queue as plain data: what's playing, what's next, shuffle and repeat. Every function
 * returns a new state, so the player store and the tests share one implementation.
 */

export type Repeat = 'off' | 'all' | 'one';

export interface QueueItem {
  /** Unique within the queue (the same song can be queued twice). */
  key: string;
  id: number;
}

export interface QueueState {
  items: QueueItem[];
  /** Index of the current item, or -1 when nothing is queued. */
  index: number;
  shuffle: boolean;
  repeat: Repeat;
  /** Order before shuffling, restored when shuffle is turned off. */
  unshuffled: QueueItem[] | null;
}

export const EMPTY_QUEUE: QueueState = { items: [], index: -1, shuffle: false, repeat: 'off', unshuffled: null };

let keySeq = 0;
const item = (id: number): QueueItem => ({ key: `q${++keySeq}`, id });

export type Rng = () => number;

function shuffled<T>(list: T[], rng: Rng): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const current = (q: QueueState): QueueItem | null => q.items[q.index] ?? null;
export const upcoming = (q: QueueState): QueueItem[] => (q.index < 0 ? [] : q.items.slice(q.index + 1));

/** Replaces the queue with `ids`, starting at `start` (shuffled after it when `shuffle`). */
export function playList(q: QueueState, ids: number[], start = 0, shuffle = q.shuffle, rng: Rng = Math.random): QueueState {
  const items = ids.map(item);
  if (!items.length) return { ...q, items: [], index: -1, unshuffled: null, shuffle };
  const first = Math.max(0, Math.min(start, items.length - 1));
  if (!shuffle) return { ...q, items, index: first, shuffle, unshuffled: null };
  const head = items[first];
  const rest = shuffled(items.filter((_, i) => i !== first), rng);
  return { ...q, items: [head, ...rest], index: 0, shuffle, unshuffled: items };
}

/** Where to go when a song ends (`auto`) or the user presses Next. null = stop. */
export function next(q: QueueState, auto = false): QueueState | null {
  if (q.index < 0) return null;
  if (auto && q.repeat === 'one') return { ...q };
  if (q.index + 1 < q.items.length) return { ...q, index: q.index + 1 };
  if (q.repeat === 'all' || (!auto && q.repeat === 'one')) return q.items.length ? { ...q, index: 0 } : null;
  return null;
}

/** Previous: restarts the song after the first 3 seconds, otherwise goes back one. */
export function previous(q: QueueState, time: number): { queue: QueueState; restart: boolean } {
  if (q.index < 0) return { queue: q, restart: false };
  if (time > 3 || (q.index === 0 && q.repeat !== 'all')) return { queue: q, restart: true };
  const index = q.index > 0 ? q.index - 1 : q.items.length - 1;
  return { queue: { ...q, index }, restart: false };
}

export function jump(q: QueueState, index: number): QueueState {
  return index >= 0 && index < q.items.length ? { ...q, index } : q;
}

/** "Play Next": right after the current song. */
export function playNext(q: QueueState, ids: number[]): QueueState {
  if (q.index < 0) return playList(q, ids, 0, false);
  const added = ids.map(item);
  const items = [...q.items.slice(0, q.index + 1), ...added, ...q.items.slice(q.index + 1)];
  if (!q.unshuffled) return { ...q, items, unshuffled: null };
  // Also right after the current song in the original order: turning shuffle off used to move
  // "Play Next" songs to the very end of the queue.
  const at = q.unshuffled.findIndex((i) => i.key === q.items[q.index]?.key);
  const unshuffled = at < 0 ? [...q.unshuffled, ...added] : [...q.unshuffled.slice(0, at + 1), ...added, ...q.unshuffled.slice(at + 1)];
  return { ...q, items, unshuffled };
}

/** "Add to Queue": after everything already queued. */
export function addToQueue(q: QueueState, ids: number[]): QueueState {
  if (q.index < 0) return playList(q, ids, 0, false);
  const added = ids.map(item);
  return { ...q, items: [...q.items, ...added], unshuffled: q.unshuffled ? [...q.unshuffled, ...added] : null };
}

/** Moves an item in the queue (indices into `items`); the current song stays current. */
export function move(q: QueueState, from: number, to: number): QueueState {
  if (from === to || from < 0 || to < 0 || from >= q.items.length || to >= q.items.length) return q;
  const playing = q.items[q.index];
  const items = [...q.items];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return { ...q, items, index: playing ? items.indexOf(playing) : q.index };
}

export function remove(q: QueueState, index: number): QueueState {
  if (index < 0 || index >= q.items.length || index === q.index) return q;
  const gone = q.items[index];
  const items = q.items.filter((_, i) => i !== index);
  return {
    ...q,
    items,
    index: index < q.index ? q.index - 1 : q.index,
    unshuffled: q.unshuffled ? q.unshuffled.filter((i) => i.key !== gone.key) : null,
  };
}

/** Clears everything after the current song. */
export function clearUpcoming(q: QueueState): QueueState {
  if (q.index < 0) return q;
  const keep = q.items.slice(0, q.index + 1);
  const keys = new Set(keep.map((i) => i.key));
  return { ...q, items: keep, unshuffled: q.unshuffled ? q.unshuffled.filter((i) => keys.has(i.key)) : null };
}

/** Turning shuffle on shuffles what's left; turning it off restores the original order. */
export function setShuffle(q: QueueState, on: boolean, rng: Rng = Math.random): QueueState {
  if (on === q.shuffle) return q;
  const playing = q.items[q.index];
  if (on) {
    if (!playing) return { ...q, shuffle: true };
    const rest = shuffled(q.items.filter((_, i) => i !== q.index), rng);
    return { ...q, shuffle: true, unshuffled: q.items, items: [playing, ...rest], index: 0 };
  }
  const original = q.unshuffled ?? q.items;
  const known = new Set(original.map((i) => i.key));
  const items = [...original.filter((i) => q.items.some((x) => x.key === i.key)), ...q.items.filter((i) => !known.has(i.key))];
  return { ...q, shuffle: false, unshuffled: null, items, index: playing ? items.indexOf(playing) : q.index };
}

export function cycleRepeat(q: QueueState): QueueState {
  return { ...q, repeat: q.repeat === 'off' ? 'all' : q.repeat === 'all' ? 'one' : 'off' };
}

/** Drops songs that left the library (keeps the current one playing). */
export function retain(q: QueueState, exists: (id: number) => boolean): QueueState {
  const playing = q.items[q.index];
  const items = q.items.filter((i) => i === playing || exists(i.id));
  if (items.length === q.items.length) return q;
  return {
    ...q,
    items,
    index: playing ? items.indexOf(playing) : -1,
    unshuffled: q.unshuffled ? q.unshuffled.filter((i) => items.includes(i)) : null,
  };
}
