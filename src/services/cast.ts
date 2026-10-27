import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { CastDevice, CastState, EpisodeRow, MovieRow, PlayTarget } from '../types/media';
import { epLabel, episodeTarget } from '../store/selectors';
import { logWatchTime, recordProgress } from './db';
import { closeBuiltin } from './player';
import { durationOf, planStream, registerStream, releaseStream, streamUrl, type StreamClient } from './streaming';
import { resize } from './tmdb';
import { ensureReachable } from './nas';
import { blockedMessage, limitStatus } from './limits';

export type { CastDevice, CastState } from '../types/media';

let token: string | null = null;
let triedCompat = false;
let lastSaved = 0;
let lastTick: { time: number; at: number } | null = null;

export async function discoverDevices(): Promise<CastDevice[]> {
  return invoke<CastDevice[]>('cast_discover');
}

function rowFor(target: PlayTarget): MovieRow | EpisodeRow | undefined {
  const { movies, episodes } = useLibraryStore.getState();
  return target.type === 'movie' ? movies.find((m) => m.id === target.id) : episodes.find((e) => e.id === target.id);
}

function describe(target: PlayTarget) {
  const { allItems, episodesBySeries } = useLibraryStore.getState();
  if (target.type === 'movie') {
    const item = allItems.find((i) => i.kind === 'movie' && i.versions.some((v) => v.id === target.id));
    return { title: item?.title ?? target.label, subtitle: item?.year ? String(item.year) : null, image: resize(item?.backdrop ?? item?.poster ?? null, 'w780'), next: null };
  }
  const row = rowFor(target) as EpisodeRow | undefined;
  const show = row ? allItems.find((i) => i.kind === 'tv' && i.id === row.series_id) : undefined;
  const list = row ? (episodesBySeries.get(row.series_id) ?? []) : [];
  const n = row ? list.slice(list.findIndex((e) => e.id === row.id) + 1).find((e) => e.season_number > 0) : undefined;
  return {
    title: show?.title ?? target.label,
    subtitle: row ? `${epLabel(row)} · ${row.title}` : null,
    image: resize(row?.still_path ?? show?.backdrop ?? null, 'w780'),
    next: n && show ? { ...episodeTarget(n, show), startTime: 0 } : null,
  };
}

/** Starts casting `target` from `start` seconds (stops local playback first). */
export async function castTo(device: CastDevice, target: PlayTarget, start = target.startTime, client?: StreamClient) {
  const store = useLibraryStore.getState();
  const limit = await limitStatus(store.activeProfile);
  if (limit.blocked) return store.toast(blockedMessage(store.activeProfile!, limit.blocked), 'error');
  if (!(await ensureReachable(target.filePath))) return;
  const row = rowFor(target);
  if (!row) return store.toast('That file isn’t in the library anymore', 'error');
  if (store.playerSession) await closeBuiltin();
  if (token) releaseStream(token);
  if (!client) triedCompat = false;

  const kind: StreamClient = client ?? (device.kind === 'chromecast' ? 'chromecast' : 'dlna');
  const plan = planStream(row, kind);
  const info = describe(target);
  const duration = durationOf(row);
  store.setCast({ device, target, ...info, state: 'connecting', time: start, duration, offset: 0, message: null, converting: plan.format !== 'direct' });
  try {
    token = await registerStream(row.file_path, plan);
    const url = await streamUrl(token, plan.format === 'direct' ? 0 : start, device.host);
    const contentType = plan.format === 'hls' ? 'application/x-mpegurl' : plan.format === 'ts' ? 'video/mp2t' : mimeFor(row.file_path);
    useLibraryStore.getState().patchCast({ offset: url.offset });
    await invoke('cast_start', {
      device,
      media: { url: url.url, content_type: contentType, title: info.title, subtitle: info.subtitle, image: info.image, start: plan.format === 'direct' ? start : 0, duration: duration - url.offset },
    });
  } catch (e) {
    useLibraryStore.getState().patchCast({ state: 'error', message: String(e) });
  }
}

function mimeFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'mp4' || ext === 'm4v' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'avi' ? 'video/x-msvideo' : ext === 'ts' ? 'video/mp2t' : 'video/x-matroska';
}

export function castControl(action: 'play' | 'pause' | 'stop' | 'volume', value?: number) {
  void invoke('cast_control', { action, value: value ?? null }).catch(() => {});
}

/** Seeks to an absolute time; converted streams restart the conversion there. */
export async function castSeek(time: number) {
  const cast = useLibraryStore.getState().cast;
  if (!cast) return;
  const t = Math.max(0, Math.min(time, cast.duration - 5));
  if (!cast.converting) {
    void invoke('cast_control', { action: 'seek', value: t });
    return;
  }
  await castTo(cast.device, cast.target, t, triedCompat ? 'dlna-compat' : undefined);
}

export async function stopCasting() {
  const cast = useLibraryStore.getState().cast;
  if (!cast) return;
  castControl('stop');
  await saveProgress(true);
  if (token) releaseStream(token);
  token = null;
  useLibraryStore.getState().setCast(null);
  void useLibraryStore.getState().reload();
}

async function saveProgress(force = false) {
  const cast = useLibraryStore.getState().cast;
  if (!cast || !cast.duration) return;
  if (!force && Date.now() - lastSaved < 10_000) return;
  lastSaved = Date.now();
  const absolute = cast.offset + cast.time;
  await recordProgress(cast.target.type, cast.target.id, absolute, cast.duration).catch(() => {});
  useLibraryStore.getState().patchProgress(cast.target.type, cast.target.id, absolute, cast.duration);
}

let started = false;

export async function initCastEvents() {
  if (started) return;
  started = true;
  await listen<{ state: CastState['state']; time: number; duration: number; message: string | null }>('cast-status', ({ payload }) => {
    const store = useLibraryStore.getState();
    const cast = store.cast;
    if (!cast) return;
    // A TV that refuses the original file gets a converted stream instead (once).
    if (payload.state === 'error' && cast.device.kind === 'dlna' && !cast.converting && !triedCompat) {
      triedCompat = true;
      store.toast(`${cast.device.name} couldn’t play the original file. Converting it for the TV…`, 'info');
      void castTo(cast.device, cast.target, cast.time || cast.target.startTime, 'dlna-compat');
      return;
    }
    store.patchCast({ state: payload.state, time: payload.time, message: payload.message ?? null });
    // Viewing time for Wrapped and kids' limits, counted while it actually plays.
    if (payload.state === 'playing') {
      const now = Date.now();
      if (lastTick && payload.time > lastTick.time && payload.time - lastTick.time < (now - lastTick.at) / 1000 + 3) {
        const seconds = payload.time - lastTick.time;
        const info = describe(cast.target);
        void logWatchTime(cast.target.type, cast.target.id, seconds, { title: info.subtitle?.split(' · ')[1] ?? info.title, series_id: null, series_title: cast.target.type === 'episode' ? info.title : null, genres: [], season: null, episode: null, poster: null });
      }
      lastTick = { time: payload.time, at: now };
      void saveProgress();
    } else {
      lastTick = null;
    }
    if (payload.state === 'paused') void saveProgress(true);
    if (payload.state === 'ended') {
      void recordProgress(cast.target.type, cast.target.id, cast.duration, cast.duration).then(() => useLibraryStore.getState().reload());
      if (cast.next) void castTo(cast.device, cast.next, 0);
    }
  });
}
