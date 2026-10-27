import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EpisodeRow, MediaItem, MovieRow, Profile } from '../types/media';
import type { RemoteEpisode, RemoteItem, RemoteLibrary, RemotePlayable, RemoteProfile, RemoteStream, RemoteTitle } from '../remote/types';
import * as db from './db';
import { allowedForMaturity, buildItems, continueWatching, epLabel, formatRemaining, genreBuckets, groupEpisodes, playTargetFor } from '../store/selectors';
import { blockedMessage, limitStatus } from './limits';
import { durationOf, planStream, registerStream, releaseStream, streamUrl } from './streaming';

/**
 * Answers the browser app's `/api/…` requests (forwarded by the Rust media server) with the same
 * library, profile and progress logic the desktop app uses.
 */

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Unlock keys for PIN-protected profiles (handed out after the right PIN). */
const unlocked = new Map<number, Set<string>>();
/** Stream tokens per playback (browser sessions). */
const sessions = new Map<string, { profile: number; type: 'movie' | 'episode'; id: number }>();

const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

function profileFor(id: unknown, unlock: unknown): Profile {
  const profile = useLibraryStore.getState().profiles.find((p) => p.id === Number(id));
  if (!profile) throw new ApiError(404, 'Unknown profile');
  if (profile.pin && !unlocked.get(profile.id)?.has(String(unlock ?? ''))) throw new ApiError(403, 'This profile is locked');
  return profile;
}

async function libraryFor(profile: Profile) {
  const { movies, series, episodes } = await db.loadLibrary(profile.id);
  const bySeries = groupEpisodes(episodes);
  const items = buildItems(movies, series, bySeries).filter((i) => allowedForMaturity(i, profile.maturity));
  return { movies, episodes, bySeries, items };
}

function lite(i: MediaItem, extra: Partial<RemoteItem> = {}): RemoteItem {
  return {
    key: i.key,
    kind: i.kind,
    title: i.title,
    year: i.year,
    overview: i.overview,
    poster: i.poster,
    backdrop: i.backdrop,
    logo: i.logo,
    certification: i.certification,
    imdbRating: i.imdbRating,
    runtime: i.runtime,
    seasonCount: i.seasonCount,
    genres: i.genres,
    ...extra,
  };
}

async function library(profile: Profile): Promise<RemoteLibrary> {
  const { items, bySeries } = await libraryFor(profile);
  const newest = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cw = continueWatching(items, bySeries).map((e) =>
    lite(e.item, {
      progress: e.progress,
      hint: [e.episode ? epLabel(e.episode) : '', e.target.startTime > 0 ? formatRemaining(e.remainingSeconds) : 'Next Up'].filter(Boolean).join(' · '),
    }),
  );
  const rows = [
    { title: 'Continue Watching', items: cw },
    { title: 'My List', items: items.filter((i) => i.myList).map((i) => lite(i)) },
    { title: 'Recently Added', items: newest.slice(0, 24).map((i) => lite(i)) },
    { title: 'TV Shows', items: items.filter((i) => i.kind === 'tv').map((i) => lite(i)) },
    { title: 'Movies', items: items.filter((i) => i.kind === 'movie').map((i) => lite(i)) },
  ];
  const genres = new Map<string, MediaItem[]>();
  for (const i of items) for (const g of genreBuckets(i.genres)) genres.set(g, [...(genres.get(g) ?? []), i]);
  for (const [g, list] of [...genres.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) rows.push({ title: g, items: list.map((i) => lite(i)) });
  const withArt = items.filter((i) => i.backdrop && i.overview);
  return {
    featured: withArt.length ? lite(withArt[Math.floor(Math.random() * withArt.length)]) : null,
    rows: rows.filter((r) => r.items.length),
    all: items.map((i) => lite(i)),
  };
}

function playable(target: { type: 'movie' | 'episode'; id: number; startTime: number; label: string } | null): RemotePlayable | null {
  return target ? { type: target.type, id: target.id, label: target.label, resume: target.startTime } : null;
}

async function title(profile: Profile, itemKey: string): Promise<RemoteTitle> {
  const { items, bySeries } = await libraryFor(profile);
  const item = items.find((i) => i.key === itemKey);
  if (!item) throw new ApiError(404, 'Not found');
  const episodes: RemoteEpisode[] = (item.kind === 'tv' ? (bySeries.get(item.id) ?? []) : []).map((e) => {
    const dur = e.duration_seconds || (e.runtime ?? 0) * 60;
    return {
      id: e.id,
      season: e.season_number,
      episode: e.episode_number,
      title: e.title,
      overview: e.overview,
      still: e.still_path,
      runtime: e.runtime,
      progress: e.watched ? 1 : dur && e.progress_seconds ? e.progress_seconds / dur : 0,
      watched: !!e.watched,
    };
  });
  return {
    item: lite(item),
    cast: item.cast.filter((c) => !c.job).slice(0, 6).map((c) => c.name),
    play: playable(playTargetFor(item, bySeries)),
    episodes,
  };
}

async function play(profile: Profile, type: 'movie' | 'episode', id: number, start?: number): Promise<RemoteStream> {
  const st = await limitStatus(profile);
  if (st.blocked) throw new ApiError(403, blockedMessage(profile, st.blocked));
  const { movies, episodes, bySeries, items } = await libraryFor(profile);
  const row: MovieRow | EpisodeRow | undefined = type === 'movie' ? movies.find((m) => m.id === id) : episodes.find((e) => e.id === id);
  if (!row) throw new ApiError(404, 'Not found');
  const plan = planStream(row, 'browser');
  const token = await registerStream(row.file_path, plan);
  const resume = start ?? (row.watched ? 0 : row.progress_seconds);
  const url = await streamUrl(token, plan.format === 'direct' ? 0 : resume);
  sessions.set(token, { profile: profile.id, type, id });

  let titleText = row.title;
  let subtitle: string | null = null;
  let next: RemotePlayable | null = null;
  if (type === 'episode') {
    const e = row as EpisodeRow;
    const show = items.find((i) => i.kind === 'tv' && i.id === e.series_id);
    titleText = show?.title ?? e.title;
    subtitle = `${epLabel(e)} · ${e.title}`;
    const list = bySeries.get(e.series_id) ?? [];
    const n = list.slice(list.findIndex((x) => x.id === e.id) + 1).find((x) => x.season_number > 0);
    if (n) next = { type: 'episode', id: n.id, label: `${epLabel(n)} · ${n.title}`, resume: 0 };
  }
  return { token, url: url.path, offset: url.offset, duration: durationOf(row), mode: plan.format === 'direct' ? 'direct' : 'hls', title: titleText, subtitle, start: resume, next };
}

async function progress(profile: Profile, body: { type: 'movie' | 'episode'; id: number; time: number; duration: number; watched?: number }) {
  await db.recordProgress(body.type, body.id, body.time, body.duration, profile.id);
  if (body.watched && body.watched > 0) {
    const { movies, episodes } = useLibraryStore.getState();
    const meta =
      body.type === 'movie'
        ? (() => {
            const m = movies.find((x) => x.id === body.id);
            return { title: m?.title ?? '', series_id: null, series_title: null, genres: [], season: null, episode: null, poster: m?.poster_path ?? null };
          })()
        : (() => {
            const e = episodes.find((x) => x.id === body.id);
            const s = useLibraryStore.getState().series.find((x) => x.id === e?.series_id);
            return { title: e?.title ?? '', series_id: s?.id ?? null, series_title: s?.title ?? null, genres: [], season: e?.season_number ?? null, episode: e?.episode_number ?? null, poster: s?.poster_path ?? null };
          })();
    await db.logWatchTime(body.type, body.id, Math.min(body.watched, 120), meta, profile.id);
  }
  // Keep the desktop app's rows current when the same profile is open there.
  if (useLibraryStore.getState().activeProfile?.id === profile.id) void useLibraryStore.getState().reload();
  const st = await limitStatus(profile);
  return { ok: true, blocked: st.blocked ? blockedMessage(profile, st.blocked) : null };
}

async function route(method: string, path: string, query: Record<string, string>, body: Record<string, unknown>): Promise<unknown> {
  const p = () => profileFor(query.profile ?? body.profile, query.key ?? body.key);
  if (method === 'GET' && path === '/profiles') {
    return useLibraryStore.getState().profiles.map<RemoteProfile>((x) => ({ id: x.id, name: x.name, color: x.color, maturity: x.maturity, locked: !!x.pin }));
  }
  if (method === 'POST' && path === '/unlock') {
    const profile = useLibraryStore.getState().profiles.find((x) => x.id === Number(body.profile));
    if (!profile) throw new ApiError(404, 'Unknown profile');
    if (profile.pin && profile.pin !== String(body.pin ?? '')) {
      await new Promise((r) => setTimeout(r, 600));
      throw new ApiError(403, 'Wrong PIN');
    }
    const k = key();
    unlocked.set(profile.id, new Set([...(unlocked.get(profile.id) ?? []), k]));
    return { key: k };
  }
  if (method === 'GET' && path === '/library') return library(p());
  if (method === 'GET' && path === '/title') return title(p(), query.item);
  if (method === 'POST' && path === '/play') return play(p(), body.type as 'movie' | 'episode', Number(body.id), body.start != null ? Number(body.start) : undefined);
  if (method === 'POST' && path === '/seek') {
    const s = sessions.get(String(body.token));
    if (!s) throw new ApiError(404, 'Playback ended');
    const url = await streamUrl(String(body.token), Number(body.time) || 0);
    return { url: url.path, offset: url.offset };
  }
  if (method === 'POST' && path === '/progress') return progress(p(), body as never);
  if (method === 'POST' && path === '/mylist') {
    await db.setMyList(body.kind as 'movie' | 'tv', Number(body.id), !!body.value, p().id);
    return { ok: true };
  }
  if (method === 'POST' && path === '/stop') {
    sessions.delete(String(body.token));
    releaseStream(String(body.token));
    return { ok: true };
  }
  throw new ApiError(404, 'Unknown endpoint');
}

let started = false;

export async function initRemoteApi() {
  if (started) return;
  started = true;
  await listen<{ id: number; method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | null }>('remote-api', async ({ payload }) => {
    let status = 200;
    let body: unknown;
    try {
      body = await route(payload.method, payload.path, payload.query ?? {}, payload.body ?? {});
    } catch (e) {
      status = e instanceof ApiError ? e.status : 500;
      body = { error: e instanceof Error ? e.message : String(e) };
    }
    await invoke('remote_api_reply', { id: payload.id, status, body: JSON.stringify(body ?? null) }).catch(() => {});
  });
}

/** Applies the browser-access setting to the media server (at launch and when it changes). */
export async function applyRemoteAccess() {
  const { settings, updateSettings } = useLibraryStore.getState();
  let code = settings.remote_code;
  if (settings.remote_access && !/^\d{6}$/.test(code)) {
    code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await updateSettings({ remote_code: code });
  }
  return invoke<{ port: number; addresses: string[]; web_enabled: boolean }>('remote_access_set', {
    enabled: settings.remote_access,
    code,
    port: settings.remote_port || 8732,
  });
}
