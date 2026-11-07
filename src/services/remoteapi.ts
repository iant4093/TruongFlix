import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EpisodeRow, MediaItem, MovieRow, Profile } from '../types/media';
import type {
  RemoteAudioTrack,
  RemoteEpisode,
  RemoteItem,
  RemoteLibrary,
  RemotePlayable,
  RemoteProfile,
  RemoteStream,
  RemoteSubStyle,
  RemoteSubTrack,
  RemoteTitle,
} from '../remote/types';
import * as db from './db';
import { allowedForMaturity, buildItems, continueWatching, epLabel, formatRemaining, genreBuckets, groupEpisodes, playTargetFor } from '../store/selectors';
import { blockedMessage, limitStatus } from './limits';
import { parseMediaInfo, parseSegments } from './mediainfo';
import { subtitleOptions } from './player';
import { durationOf, planStream, probeStream, registerStream, releaseStream, streamUrl } from './streaming';
import { languageName } from './subtitles';
import { downloadBlockingPlayback, stillDownloadingMessage } from './torrents';

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

/** The signed-in browser a request came from (identified by the media server). */
interface Caller {
  session: string;
  device: string;
}

const UNLOCK_TTL = 12 * 3600_000;
const PIN_TRIES = 5;
const PIN_LOCKOUT = 15 * 60_000;
/** Simultaneous browser playbacks across all devices (each may be converting video). */
export const MAX_REMOTE_STREAMS = 4;
/** Playback whose browser stopped reporting (closed tab, lost connection) is released after this. */
export const STREAM_IDLE_MS = 2 * 60_000;

/** Unlock keys for PIN-protected profiles: valid for 12 hours and only while the PIN is unchanged. */
const unlocked = new Map<number, Map<string, { pin: string; expires: number }>>();
const pinFailures = new Map<number, number[]>();
/** Browser playbacks by stream token. Only the signed-in browser that started one may control it. */
const sessions = new Map<string, { session: string; profile: number; type: 'movie' | 'episode'; id: number; lastProgress: number; lastSeen: number }>();

const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

function profileFor(id: unknown, unlock: unknown): Profile {
  const profile = useLibraryStore.getState().profiles.find((p) => p.id === Number(id));
  if (!profile) throw new ApiError(404, 'Unknown profile');
  if (profile.pin) {
    const entry = unlocked.get(profile.id)?.get(String(unlock ?? ''));
    if (!entry || entry.expires < Date.now() || entry.pin !== profile.pin) throw new ApiError(403, 'This profile is locked');
  }
  return profile;
}

async function libraryFor(profile: Profile) {
  const { movies, series, episodes } = await db.loadLibrary(profile.id);
  const bySeries = groupEpisodes(episodes);
  const items = buildItems(movies, series, bySeries).filter((i) => allowedForMaturity(i, profile.maturity));
  return { movies, episodes, bySeries, items };
}

/** Whether the profile may see a movie (any version) or an episode (via its show's rating). */
function allowedTitle(items: MediaItem[], episodes: EpisodeRow[], type: 'movie' | 'episode', id: number) {
  if (type === 'movie') return items.some((i) => i.kind === 'movie' && (i.id === id || i.versions.some((v) => v.id === id)));
  const episode = episodes.find((e) => e.id === id);
  return !!episode && items.some((i) => i.kind === 'tv' && i.id === episode.series_id);
}

/** Whether the profile may see a movie or an episode (via its show's rating), reading just that row. */
async function allowedRow(profile: Profile, type: 'movie' | 'episode', id: number) {
  if (!Number.isFinite(id)) return false;
  const conn = await db.getDb();
  const rows = await conn.select<{ certification: string | null }[]>(
    type === 'movie'
      ? 'SELECT certification FROM movies WHERE id = $1'
      : 'SELECT s.certification FROM episodes e JOIN tv_series s ON s.id = e.series_id WHERE e.id = $1',
    [id],
  );
  if (!rows.length) return false;
  return allowedForMaturity({ certification: rows[0].certification || null } as MediaItem, profile.maturity);
}

function ownedStream(token: unknown, caller: Caller) {
  const entry = sessions.get(String(token ?? ''));
  return entry && entry.session === caller.session ? entry : null;
}

function stopStream(token: string) {
  sessions.delete(token);
  releaseStream(token);
}

/** Releases playback nobody has reported progress for in a while (abandoned tabs). */
export function sweepIdleStreams(now = Date.now()) {
  for (const [token, s] of [...sessions]) if (now - s.lastSeen > STREAM_IDLE_MS) stopStream(token);
}

/** Ends playback that belonged to a browser that was signed out. */
export function endRemoteSession(session: string) {
  for (const [token, s] of [...sessions]) if (s.session === session) stopStream(token);
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
    rtScore: i.rtScore,
    metacritic: i.metacritic,
    stinger: i.stinger,
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

function channelTag(channels: number | null): string | null {
  if (!channels) return null;
  if (channels >= 8) return '7.1';
  if (channels >= 6) return '5.1';
  if (channels === 2) return 'Stereo';
  if (channels === 1) return 'Mono';
  return `${channels}ch`;
}

interface PlayOptions {
  start?: number;
  aid?: number;
  sid?: number;
  subStyle?: Partial<RemoteSubStyle>;
}

async function play(caller: Caller, profile: Profile, type: 'movie' | 'episode', id: number, opts: PlayOptions = {}): Promise<RemoteStream> {
  const st = await limitStatus(profile);
  if (st.blocked) throw new ApiError(403, blockedMessage(profile, st.blocked));
  // One playback per browser: starting another replaces it.
  for (const [token, s] of [...sessions]) if (s.session === caller.session) stopStream(token);
  sweepIdleStreams();
  if (sessions.size >= MAX_REMOTE_STREAMS) throw new ApiError(429, 'Too many devices are watching right now. Stop playback on another device and try again.');
  const { movies, episodes, bySeries, items } = await libraryFor(profile);
  const row: MovieRow | EpisodeRow | undefined = type === 'movie' ? movies.find((m) => m.id === id) : episodes.find((e) => e.id === id);
  if (!row || !allowedTitle(items, episodes, type, id)) throw new ApiError(404, 'Not found');

  const { settings, torrents } = useLibraryStore.getState();
  if (downloadBlockingPlayback(row.file_path, torrents)) throw new ApiError(409, stillDownloadingMessage(row.title));
  const probe = await probeStream(row.file_path).catch(() => null);
  const defaultAudio = probe?.audio.find((a) => a.selected) ?? probe?.audio.find((a) => a.default) ?? probe?.audio[0] ?? null;
  const chosenAid = opts.aid != null && opts.aid > 0 ? opts.aid : (defaultAudio?.id ?? null);

  let chosenSid = 0;
  if (opts.sid != null) {
    chosenSid = Math.max(0, opts.sid);
  } else if (probe?.subs.length) {
    const savedPath = await db.getSelectedSubtitlePath(type, id).catch(() => null);
    const saved = savedPath ? probe.subs.find((s) => s.external_filename === savedPath) : undefined;
    const def = saved ?? probe.subs.find((s) => s.selected) ?? probe.subs.find((s) => s.forced && s.default);
    chosenSid = def?.id ?? 0;
  }

  const subStyle: RemoteSubStyle = {
    size: opts.subStyle?.size ?? settings.subtitle_style.size,
    background: opts.subStyle?.background ?? settings.subtitle_style.background,
  };
  const mpvSubStyle = subtitleOptions({ ...settings.subtitle_style, ...subStyle });

  const plan = planStream(row, 'browser', {
    aid: chosenAid,
    defaultAid: defaultAudio?.id ?? null,
    sid: chosenSid,
    subStyle: mpvSubStyle,
  });
  const token = await registerStream(row.file_path, plan);
  const resume = opts.start != null ? Math.max(0, opts.start) : row.watched ? 0 : row.progress_seconds;
  const url = await streamUrl(token, plan.format === 'direct' ? 0 : resume);
  sessions.set(token, { session: caller.session, profile: profile.id, type, id, lastProgress: Date.now(), lastSeen: Date.now() });

  let titleText = row.title;
  let subtitle: string | null = null;
  let next: RemotePlayable | null = null;
  let stinger: RemoteStream['stinger'] = null;
  if (type === 'episode') {
    const e = row as EpisodeRow;
    const show = items.find((i) => i.kind === 'tv' && i.id === e.series_id);
    titleText = show?.title ?? e.title;
    subtitle = `${epLabel(e)} · ${e.title}`;
    const list = bySeries.get(e.series_id) ?? [];
    const n = list.slice(list.findIndex((x) => x.id === e.id) + 1).find((x) => x.season_number > 0);
    if (n) next = { type: 'episode', id: n.id, label: `${epLabel(n)} · ${n.title}`, resume: 0 };
  } else {
    const m = row as MovieRow;
    if (m.stinger === 'during' || m.stinger === 'after' || m.stinger === 'both') stinger = m.stinger;
  }

  const audioTracks: RemoteAudioTrack[] = (probe?.audio ?? []).map((a) => ({
    id: a.id,
    label: a.lang ? languageName(a.lang) : a.title || `Track ${a.id}`,
    detail: [a.lang ? a.title : null, channelTag(a.channels)].filter(Boolean).join(' · ') || null,
    selected: a.id === chosenAid,
  }));

  const subTracks: RemoteSubTrack[] = (probe?.subs ?? []).map((s) => ({
    id: s.id,
    label: s.lang ? languageName(s.lang) : s.title || `Subtitles ${s.id}`,
    detail: [s.lang ? s.title : null, s.forced ? 'Forced' : null, s.external ? 'Downloaded' : null].filter(Boolean).join(' · ') || null,
    selected: s.id === chosenSid,
  }));

  const chapters = probe?.chapters?.length ? probe.chapters : (parseMediaInfo(row.media_info)?.chapters ?? []);
  const segments = parseSegments(row.segments).map(({ kind, start: s, end }) => ({ kind, start: s, end }));
  const duration = probe?.duration || durationOf(row);

  return {
    token,
    url: url.path,
    offset: url.offset,
    duration,
    mode: plan.format === 'direct' ? 'direct' : 'hls',
    title: titleText,
    subtitle,
    start: resume,
    next,
    aid: chosenAid,
    sid: chosenSid,
    audioTracks,
    subTracks,
    chapters,
    segments,
    stinger,
    subStyle,
  };
}

async function progress(caller: Caller, profile: Profile, body: { type: 'movie' | 'episode'; id: number; time: number; duration: number; watched?: number; token?: string }) {
  const type = body.type === 'episode' ? 'episode' : 'movie';
  const id = Number(body.id);
  if (!(await allowedRow(profile, type, id))) throw new ApiError(404, 'Not found');
  const time = Math.max(0, Number(body.time) || 0);
  const duration = Math.max(0, Number(body.duration) || 0);
  await db.recordProgress(type, id, time, duration, profile.id);
  // Watch time counts toward daily limits; credit no more than the real time since the last report.
  const stream = ownedStream(body.token, caller);
  let watched = 0;
  if (stream && stream.profile === profile.id && stream.type === type && stream.id === id) {
    const now = Date.now();
    watched = Math.min(Math.max(0, Number(body.watched) || 0), (now - stream.lastProgress) / 1000 + 5, 120);
    stream.lastProgress = now;
    stream.lastSeen = now;
  }
  body = { ...body, type, id, watched };
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
  if (useLibraryStore.getState().activeProfile?.id === profile.id) useLibraryStore.getState().patchProgress(type, id, time, duration);
  const st = await limitStatus(profile);
  // A limit reached during playback stops the stream here too, not just in the browser.
  if (st.blocked) for (const [token, s] of [...sessions]) if (s.profile === profile.id) stopStream(token);
  return { ok: true, blocked: st.blocked ? blockedMessage(profile, st.blocked) : null };
}

async function unlock(body: Record<string, unknown>) {
  const profile = useLibraryStore.getState().profiles.find((x) => x.id === Number(body.profile));
  if (!profile) throw new ApiError(404, 'Unknown profile');
  const now = Date.now();
  const failures = (pinFailures.get(profile.id) ?? []).filter((t) => now - t < PIN_LOCKOUT);
  if (failures.length >= PIN_TRIES) {
    const minutes = Math.max(1, Math.ceil((PIN_LOCKOUT - (now - failures[0])) / 60_000));
    throw new ApiError(429, `Too many wrong PINs. Try again in ${minutes} minutes.`);
  }
  if (profile.pin && profile.pin !== String(body.pin ?? '')) {
    failures.push(now);
    pinFailures.set(profile.id, failures);
    await new Promise((r) => setTimeout(r, 600));
    const left = PIN_TRIES - failures.length;
    throw new ApiError(403, left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong PINs. Try again in 15 minutes.');
  }
  pinFailures.delete(profile.id);
  const keys = unlocked.get(profile.id) ?? new Map<string, { pin: string; expires: number }>();
  for (const [k, v] of keys) if (v.expires < now) keys.delete(k);
  const k = key();
  keys.set(k, { pin: profile.pin, expires: now + UNLOCK_TTL });
  unlocked.set(profile.id, keys);
  return { key: k };
}

export async function route(caller: Caller, method: string, path: string, query: Record<string, string>, body: Record<string, unknown>): Promise<unknown> {
  const p = () => profileFor(query.profile ?? body.profile, query.key ?? body.key);
  if (method === 'GET' && path === '/profiles') {
    return useLibraryStore.getState().profiles.map<RemoteProfile>((x) => ({ id: x.id, name: x.name, color: x.color, maturity: x.maturity, locked: !!x.pin }));
  }
  if (method === 'POST' && path === '/unlock') return unlock(body);
  if (method === 'GET' && path === '/library') return library(p());
  if (method === 'GET' && path === '/title') return title(p(), query.item);
  if (method === 'POST' && path === '/play') {
    return play(caller, p(), body.type === 'episode' ? 'episode' : 'movie', Number(body.id), {
      start: body.start != null ? Number(body.start) : undefined,
      aid: body.aid != null ? Number(body.aid) : undefined,
      sid: body.sid != null ? Number(body.sid) : undefined,
      subStyle: (body.subStyle as Partial<RemoteSubStyle> | undefined) ?? undefined,
    });
  }
  if (method === 'POST' && path === '/seek') {
    const s = ownedStream(body.token, caller);
    if (!s) throw new ApiError(404, 'Playback ended');
    s.lastSeen = Date.now();
    const profile = useLibraryStore.getState().profiles.find((x) => x.id === s.profile);
    const st = profile ? await limitStatus(profile) : null;
    if (!profile || st?.blocked) {
      stopStream(String(body.token));
      throw new ApiError(403, profile && st?.blocked ? blockedMessage(profile, st.blocked) : 'Playback ended');
    }
    const url = await streamUrl(String(body.token), Math.max(0, Number(body.time) || 0));
    return { url: url.path, offset: url.offset };
  }
  if (method === 'POST' && path === '/progress') return progress(caller, p(), body as never);
  if (method === 'POST' && path === '/mylist') {
    const profile = p();
    const kind = body.kind === 'tv' ? 'tv' : 'movie';
    const { items } = await libraryFor(profile);
    if (!items.some((i) => i.kind === kind && i.id === Number(body.id))) throw new ApiError(404, 'Not found');
    await db.setMyList(kind, Number(body.id), !!body.value, profile.id);
    return { ok: true };
  }
  if (method === 'POST' && path === '/stop') {
    if (ownedStream(body.token, caller)) stopStream(String(body.token));
    return { ok: true };
  }
  throw new ApiError(404, 'Unknown endpoint');
}

let started = false;

function describeSecurity(e: { kind: string; device: string; ip: string }) {
  if (e.kind === 'signin') return { message: `${e.device} signed in to TruongFlix in a browser (${e.ip})`, level: 'info' as const };
  if (e.kind === 'locked') return { message: `Blocked browser sign-in from ${e.device} (${e.ip}) after 5 wrong codes`, level: 'error' as const };
  return { message: 'Browser sign-in is paused after too many wrong codes. Make a new code in Settings › Devices.', level: 'error' as const };
}

export async function initRemoteApi() {
  if (started) return;
  started = true;
  setInterval(() => sweepIdleStreams(), 30_000);
  await listen<{ id: number; method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | null; session: string; device: string }>('remote-api', async ({ payload }) => {
    let status = 200;
    let body: unknown;
    try {
      const caller: Caller = { session: payload.session, device: payload.device };
      body = await route(caller, payload.method, payload.path, payload.query ?? {}, payload.body ?? {});
    } catch (e) {
      status = e instanceof ApiError ? e.status : 500;
      // Unexpected errors can contain file paths; browsers only get a generic message.
      body = { error: e instanceof ApiError ? e.message : 'Something went wrong. Try again.' };
      if (!(e instanceof ApiError)) console.warn('[remote]', e);
    }
    await invoke('remote_api_reply', { id: payload.id, status, body: JSON.stringify(body ?? null) }).catch(() => {});
  });
  await listen<string>('remote-session-ended', ({ payload }) => endRemoteSession(payload));
  await listen<{ kind: string; device: string; ip: string }>('remote-security', ({ payload }) => {
    const { message, level } = describeSecurity(payload);
    useLibraryStore.getState().toast(message, level);
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
  return invoke<{ port: number; addresses: string[]; web_enabled: boolean; encoder?: string | null; login_paused?: boolean }>('remote_access_set', {
    enabled: settings.remote_access,
    code,
    port: settings.remote_port || 8732,
  });
}
