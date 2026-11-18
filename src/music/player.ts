import { create } from 'zustand';
import type { MusicApi } from './api';
import type { MusicLibrary, MusicTrack } from './types';
import * as Q from './queue';
import { connectAnalyser, resumeAnalyser } from './analyser';

/**
 * The music player, shared by the desktop and browser apps: an HTML `<audio>` element fed by the
 * PC's media server (byte ranges, so seeking works), a second element that preloads the next song
 * so it starts without a gap, and the queue logic from `queue.ts`.
 */

export type Panel = 'lyrics' | 'queue' | null;

export interface MusicPlayerState {
  api: MusicApi | null;
  library: MusicLibrary | null;
  byId: Map<number, MusicTrack>;
  queue: Q.QueueState;
  track: MusicTrack | null;
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  full: boolean;
  /** The bottom bar was closed: playback carries on, and the bar comes back with the next song you pick. */
  barHidden: boolean;
  panel: Panel;
  error: string | null;
}

const VOLUME_KEY = 'tf-music-volume';
const savedVolume = () => {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && localStorage.getItem(VOLUME_KEY) != null ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
};

export const useMusicPlayer = create<MusicPlayerState>(() => ({
  api: null,
  library: null,
  byId: new Map(),
  queue: Q.EMPTY_QUEUE,
  track: null,
  playing: false,
  loading: false,
  time: 0,
  duration: 0,
  volume: savedVolume(),
  muted: false,
  full: false,
  barHidden: false,
  panel: null,
  error: null,
}));

const set = useMusicPlayer.setState;
const get = useMusicPlayer.getState;

// ---------------------------------------------------------------------------
// Audio elements
// ---------------------------------------------------------------------------

interface Slot {
  el: HTMLAudioElement;
  /** Queue item key and track this element has loaded. */
  key: string | null;
  trackId: number | null;
  url: string | null;
}

let slots: [Slot, Slot] | null = null;
let active = 0;
let loadSeq = 0;
let options = { mediaSession: false, visualizer: false };
let listened = 0;
let counted = false;
let lastTick = 0;
let retried = false;
let unlocked = false;
let silentUrl: string | null = null;

const activeSlot = () => ensureSlots()[active];
const spareSlot = () => ensureSlots()[1 - active];

function ensureSlots(): [Slot, Slot] {
  if (slots) return slots;
  const make = (): Slot => {
    const el = new Audio();
    el.preload = 'auto';
    // The visualizer reads the audio, which needs a CORS load (the media server allows it).
    el.crossOrigin = options.visualizer ? 'anonymous' : null;
    return { el, key: null, trackId: null, url: null };
  };
  slots = [make(), make()];
  for (const slot of slots) wire(slot);
  applyVolume();
  return slots;
}

function applyVolume() {
  if (!slots) return;
  const { volume, muted } = get();
  for (const s of slots) {
    s.el.volume = volume;
    s.el.muted = muted;
  }
}

/** A tiny silent WAV, so the first tap can unlock playback on phones before the real URL arrives. */
function silence(): string {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silentUrl;
}

/** Called synchronously from a tap/click: lets both elements play later without another tap. */
function unlock() {
  if (options.visualizer) connectAnalyser(ensureSlots().map((s) => s.el));
  if (unlocked) return;
  unlocked = true;
  for (const s of ensureSlots()) {
    if (s.el.src) continue;
    try {
      s.el.src = silence();
      void s.el.play().then(() => s.el.pause()).catch(() => {});
    } catch {
      /* not supported (tests) */
    }
  }
}

function wire(slot: Slot) {
  const el = slot.el;
  const mine = () => slots?.[active] === slot && slot.key != null;
  el.addEventListener('timeupdate', () => {
    if (!mine()) return;
    const t = el.currentTime;
    const delta = t - lastTick;
    lastTick = t;
    if (delta > 0 && delta < 1.5) listened += delta;
    maybeCount();
    if (Math.abs(t - get().time) >= 0.25) set({ time: t });
    maybePreload();
    if (options.mediaSession) positionState();
  });
  el.addEventListener('durationchange', () => {
    if (mine() && Number.isFinite(el.duration) && el.duration > 0) set({ duration: el.duration });
  });
  el.addEventListener('playing', () => {
    if (!mine()) return;
    stalledAt = null;
    set({ playing: true, loading: false, error: null });
  });
  el.addEventListener('play', () => {
    if (!mine()) return;
    resumeAnalyser();
    set({ playing: true });
  });
  el.addEventListener('pause', () => mine() && !el.ended && set({ playing: false }));
  el.addEventListener('waiting', () => {
    if (!mine()) return;
    // Safari can keep counting time while it waits for audio: the lyrics hold here until it plays.
    stalledAt = el.currentTime;
    set({ loading: true });
  });
  el.addEventListener('seeking', () => mine() && (stalledAt = null));
  el.addEventListener('canplay', () => mine() && set({ loading: false }));
  el.addEventListener('ended', () => mine() && onEnded());
  el.addEventListener('error', () => mine() && el.src !== silentUrl && onError());
}

function maybeCount() {
  const { track, api } = get();
  if (counted || !track || !api) return;
  if (listened >= Math.min(30, Math.max(5, track.duration * 0.5))) {
    counted = true;
    const now = Date.now();
    void api.played(track.id).catch(() => {});
    patchTrack(track.id, { plays: track.plays + 1, lastPlayed: now });
  }
}

async function urlFor(track: MusicTrack): Promise<string> {
  const api = get().api;
  if (!api) throw new Error('Music isn’t ready');
  return (await api.stream(track)).url;
}

/** Starts fetching the next song a little before this one ends. */
function maybePreload() {
  const { queue, duration, time } = get();
  if (!duration || duration - time > 20) return;
  const upcoming = Q.next(queue, true);
  if (!upcoming || upcoming.index === queue.index) return;
  const item = Q.current(upcoming);
  const spare = spareSlot();
  if (!item || spare.key === item.key) return;
  const track = get().byId.get(item.id);
  if (!track) return;
  spare.key = item.key;
  spare.trackId = track.id;
  spare.url = null;
  urlFor(track)
    .then((url) => {
      if (spare.key !== item.key) return;
      spare.url = url;
      spare.el.src = url;
      spare.el.load();
    })
    .catch(() => {
      if (spare.key === item.key) spare.key = null;
    });
}

async function load(item: Q.QueueItem | null, autoplay: boolean, startAt = 0) {
  const seq = ++loadSeq;
  const track = item ? get().byId.get(item.id) ?? null : null;
  const prev = activeSlot();
  listened = 0;
  counted = false;
  lastTick = startAt;
  retried = false;
  stalledAt = null;
  if (!item || !track) {
    prev.el.pause();
    set({ track: null, playing: false, loading: false, time: 0, duration: 0 });
    updateMediaSession();
    return;
  }
  set({ track, time: startAt, duration: track.duration, loading: true, error: null });
  updateMediaSession();
  const spare = spareSlot();
  if (spare.key === item.key && spare.url) {
    // Preloaded: swap elements so the next song starts right away.
    prev.el.pause();
    prev.key = null;
    active = 1 - active;
    const el = spare.el;
    if (startAt) el.currentTime = startAt;
    else if (el.currentTime) el.currentTime = 0;
    if (autoplay) await el.play().catch(() => set({ playing: false, loading: false }));
    else set({ loading: false });
    return;
  }
  prev.el.pause();
  let url: string;
  try {
    url = await urlFor(track);
  } catch (e) {
    if (seq === loadSeq) set({ loading: false, playing: false, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (seq !== loadSeq) return;
  const slot = activeSlot();
  slot.key = item.key;
  slot.trackId = track.id;
  slot.url = url;
  slot.el.src = url;
  if (startAt) slot.el.currentTime = startAt;
  if (autoplay) await slot.el.play().catch((e) => seq === loadSeq && set({ playing: false, loading: false, error: e?.name === 'NotAllowedError' ? null : 'This song couldn’t be played' }));
  else set({ loading: false });
}

function onEnded() {
  const { queue } = get();
  const n = Q.next(queue, true);
  if (!n) {
    // End of the queue: back to the start of the last song, paused.
    const el = activeSlot().el;
    el.currentTime = 0;
    set({ playing: false, time: 0 });
    return;
  }
  if (n.index === queue.index) {
    const el = activeSlot().el;
    el.currentTime = 0;
    listened = 0;
    counted = false;
    lastTick = 0;
    void el.play();
    return;
  }
  set({ queue: n });
  void load(Q.current(n), true);
}

function onError() {
  const { track, queue } = get();
  if (!track) return;
  const el = activeSlot().el;
  if (!retried) {
    // The server may have restarted on another port: ask for a fresh URL once.
    retried = true;
    const at = el.currentTime || get().time;
    void urlFor(track)
      .then((url) => {
        const slot = activeSlot();
        slot.url = url;
        slot.el.src = url;
        slot.el.currentTime = at;
        return slot.el.play();
      })
      .catch(() => onError());
    return;
  }
  set({ playing: false, loading: false, error: 'This song couldn’t be played' });
  const n = Q.next(queue, false);
  if (n && n.index !== queue.index) {
    setTimeout(() => {
      if (get().track?.id === track.id) {
        set({ queue: n });
        void load(Q.current(n), true);
      }
    }, 1500);
  }
}

// ---------------------------------------------------------------------------
// Media Session (browser lock screen / headphones)
// ---------------------------------------------------------------------------

let lastPosition = 0;

function positionState(force = false) {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  const { duration, time } = get();
  if (!ms?.setPositionState || !duration) return;
  const now = Date.now();
  if (!force && now - lastPosition < 5000) return;
  lastPosition = now;
  try {
    ms.setPositionState({ duration, position: Math.min(time, duration), playbackRate: 1 });
  } catch {
    /* ignore */
  }
}

function updateMediaSession() {
  if (!options.mediaSession || typeof navigator === 'undefined' || !navigator.mediaSession) return;
  const { track, api } = get();
  const ms = navigator.mediaSession;
  if (!track) {
    ms.metadata = null;
    return;
  }
  const art = api?.artUrl(track.art);
  try {
    ms.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: art ? [{ src: new URL(art, location.href).href, sizes: '512x512' }] : [],
    });
  } catch {
    /* MediaMetadata missing */
  }
  positionState(true);
}

function installMediaSession() {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!ms) return;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => resume()],
    ['pause', () => pause()],
    ['previoustrack', () => previous()],
    ['nexttrack', () => next()],
    ['seekto', (d) => d.seekTime != null && seek(d.seekTime)],
    ['seekbackward', (d) => seek(get().time - (d.seekOffset ?? 10))],
    ['seekforward', (d) => seek(get().time + (d.seekOffset ?? 10))],
  ];
  for (const [action, fn] of handlers) {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* unsupported action */
    }
  }
  useMusicPlayer.subscribe((s, p) => {
    if (s.playing !== p.playing) ms.playbackState = s.track ? (s.playing ? 'playing' : 'paused') : 'none';
  });
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/** `visualizer` routes the audio through Web Audio for live now-playing bars (desktop only). */
export function initMusicPlayer(api: MusicApi, opts: { mediaSession?: boolean; visualizer?: boolean } = {}) {
  const first = !get().api;
  options = { mediaSession: !!opts.mediaSession, visualizer: !!opts.visualizer && !slots };
  set({ api });
  if (first && options.mediaSession) installMediaSession();
}

export function setMusicLibrary(library: MusicLibrary) {
  const byId = new Map(library.tracks.map((t) => [t.id, t]));
  const { queue, track } = get();
  set({ library, byId, queue: Q.retain(queue, (id) => byId.has(id)), track: track ? byId.get(track.id) ?? track : null });
}

/** Updates one song everywhere (favourite, play count). */
export function patchTrack(id: number, patch: Partial<MusicTrack>) {
  const { library, byId, track } = get();
  const old = byId.get(id);
  if (!old) return;
  const updated = { ...old, ...patch };
  const map = new Map(byId);
  map.set(id, updated);
  set({
    byId: map,
    track: track?.id === id ? updated : track,
    library: library ? { ...library, tracks: library.tracks.map((t) => (t.id === id ? updated : t)) } : library,
  });
}

/** Plays `ids` starting at `start`. Call straight from a tap so phones allow the audio. */
export function playTracks(ids: number[], start = 0, opts: { shuffle?: boolean } = {}) {
  unlock();
  const q = Q.playList(get().queue, ids, start, opts.shuffle ?? get().queue.shuffle);
  set({ queue: q, barHidden: false });
  void load(Q.current(q), true);
}

export function toggle() {
  if (get().playing) pause();
  else resume();
}

export function pause() {
  activeSlot().el.pause();
  set({ playing: false });
}

export function resume() {
  unlock();
  const { track, queue } = get();
  const slot = activeSlot();
  if (!track) {
    const item = Q.current(queue);
    if (item) void load(item, true);
    return;
  }
  if (!slot.key || !slot.el.src || slot.el.src === silentUrl) {
    void load(Q.current(queue), true, get().time);
    return;
  }
  void slot.el.play().catch(() => set({ playing: false }));
}

export function next() {
  unlock();
  const n = Q.next(get().queue, false);
  if (!n) return;
  set({ queue: n });
  void load(Q.current(n), true);
}

export function previous() {
  unlock();
  const { queue, restart } = Q.previous(get().queue, activeSlot().el.currentTime || get().time);
  if (restart) {
    seek(0);
    return;
  }
  set({ queue });
  void load(Q.current(queue), true);
}

export function seek(t: number) {
  const { duration } = get();
  const to = Math.max(0, Math.min(t, duration ? duration - 0.25 : t));
  const el = activeSlot().el;
  lastTick = to;
  scrubAt = null;
  if (activeSlot().key) el.currentTime = to;
  set({ time: to });
  if (options.mediaSession) positionState(true);
}

export function jumpTo(index: number) {
  unlock();
  const q = Q.jump(get().queue, index);
  if (q === get().queue && index !== get().queue.index) return;
  set({ queue: q, barHidden: false });
  void load(Q.current(q), true);
}

export function setVolume(v: number) {
  const volume = Math.min(1, Math.max(0, v));
  set({ volume, muted: volume === 0 ? get().muted : false });
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* private mode */
  }
  applyVolume();
}

export function toggleMute() {
  set({ muted: !get().muted });
  applyVolume();
}

const dropSpare = () => {
  const spare = spareSlot();
  spare.key = null;
  spare.url = null;
};

export function toggleShuffle() {
  set({ queue: Q.setShuffle(get().queue, !get().queue.shuffle) });
  dropSpare();
}

export function cycleRepeat() {
  set({ queue: Q.cycleRepeat(get().queue) });
  dropSpare();
}

export function playNext(ids: number[]) {
  const empty = get().queue.index < 0;
  if (empty) unlock();
  set({ queue: Q.playNext(get().queue, ids), ...(empty ? { barHidden: false } : {}) });
  dropSpare();
  if (empty) void load(Q.current(get().queue), true);
}

export function addToQueue(ids: number[]) {
  const empty = get().queue.index < 0;
  if (empty) unlock();
  set({ queue: Q.addToQueue(get().queue, ids), ...(empty ? { barHidden: false } : {}) });
  dropSpare();
  if (empty) void load(Q.current(get().queue), true);
}

export function moveInQueue(from: number, to: number) {
  set({ queue: Q.move(get().queue, from, to) });
  dropSpare();
}

export function removeFromQueue(index: number) {
  set({ queue: Q.remove(get().queue, index) });
  dropSpare();
}

export function clearQueue() {
  set({ queue: Q.clearUpcoming(get().queue) });
  dropSpare();
}

/** Stops and forgets the queue (e.g. switching profiles). */
export function stopMusic() {
  if (slots) for (const s of slots) {
    s.el.pause();
    s.key = null;
    s.url = null;
  }
  loadSeq++;
  set({ queue: Q.EMPTY_QUEUE, track: null, playing: false, loading: false, time: 0, duration: 0, full: false, barHidden: false });
  updateMediaSession();
}

export function setFull(full: boolean) {
  set(full ? { full, barHidden: false } : { full });
}

/** Closes (or brings back) the bottom bar without touching playback or the queue. */
export function setBarHidden(barHidden: boolean) {
  if (get().barHidden !== barHidden) set({ barHidden });
}

export function setPanel(panel: Panel) {
  set({ panel });
}

let scrubAt: number | null = null;
/** Where the song was when it stopped to wait for audio (until it plays again). */
let stalledAt: number | null = null;

/** While a seek bar is being dragged: lyrics follow the finger before the song actually jumps. */
export function setScrub(t: number | null) {
  scrubAt = t;
}

/** Precise playback time for animations (the store only updates a few times a second). */
export function musicClock(): number {
  if (scrubAt != null) return scrubAt;
  const slot = slots?.[active];
  if (!slot?.key) return get().time;
  return stalledAt != null ? Math.min(slot.el.currentTime, stalledAt) : slot.el.currentTime;
}

export async function toggleFavourite(track: MusicTrack) {
  const api = get().api;
  if (!api) return;
  patchTrack(track.id, { favourite: !track.favourite });
  try {
    await api.setFavourite(track.id, !track.favourite);
  } catch (e) {
    patchTrack(track.id, { favourite: track.favourite });
    throw e;
  }
}
