import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EpisodeRow, MediaItem, MovieRow, PlayTarget, Profile } from '../types/media';
import type {
  RemoteAudioTrack,
  RemoteEpisode,
  RemoteItem,
  RemoteLibrary,
  RemoteLive,
  RemoteLiveChannel,
  RemotePlayable,
  RemoteProfile,
  RemoteStream,
  RemoteSubStyle,
  RemoteSubTrack,
  RemoteTitle,
} from '../remote/types';
import * as db from './db';
import { allowedForMaturity, buildItems, continueWatching, epLabel, episodeTarget, formatRemaining, genreBuckets, groupEpisodes, playTargetFor } from '../store/selectors';
import { blockedMessage, limitStatus } from './limits';
import { verifyPin } from './pin';
import { parseMediaInfo, parseSegments } from './mediainfo';
import { playLive, subtitleOptions } from './player';
import { ApiError, command as remoteCommand, noteController, nowPlaying, rateLimit, startOnPc, type Caller } from './remotecontrol';
import { eventMatches, findLiveChannel, initLive, LEAGUES, localDate, sportsSchedule, useLiveStore, webPlayerUrl } from './live';
import type { LiveChannel, LivePlaylist, LivePreferences } from '../types/live';
import {
  conversionKbps,
  downloadStatus,
  durationOf,
  planDownload,
  planStream,
  probeStream,
  qualityChoices,
  registerStream,
  releaseStream,
  resolveQuality,
  streamUrl,
  type QualityChoices,
} from './streaming';
import { estimateBytes, isQualityLevel, isQualityRes, QUALITY_LEVELS, resLabel, type Quality } from '../lib/quality';
import type { RemoteDownload, RemoteDownloadStatus, RemoteQualities, RemoteQualityOption } from '../remote/types';
import { languageName } from './subtitles';
import { techBadgeList } from '../components/common/TechBadges';
import { downloadBlockingPlayback, stillDownloadingMessage } from './torrents';
import { endMusicSession, musicRoute } from './musicroute';
import { togetherRoute } from './watchparty';

/**
 * Answers the browser app's `/api/…` requests (forwarded by the Rust media server) with the same
 * library, profile and progress logic the desktop app uses.
 */

const UNLOCK_TTL = 12 * 3600_000;
const PIN_TRIES = 5;
const PIN_LOCKOUT = 15 * 60_000;
/** Simultaneous browser playbacks across all devices (each may be converting video). */
export const MAX_REMOTE_STREAMS = 4;
/** Playback whose browser stopped reporting (closed tab, lost connection) is released after this. */
export const STREAM_IDLE_MS = 2 * 60_000;

/** Unlock keys for PIN-protected profiles: valid for 12 hours and only while the PIN is unchanged. */
const unlocked = new Map<number, Map<string, { pin: string; expires: number }>>();
/**
 * Wrong-PIN lockouts per profile, kept across restarts. Each lockout lasts four times longer than
 * the last (15 min, 1 h, 4 h, 16 h, then a day), so guessing a 4-digit PIN from a paired device
 * would take years instead of days.
 */
interface PinLock {
  fails: number[];
  strikes: number;
  until: number;
}
const PIN_LOCKS = 'tf-pin-lockouts';
const PIN_MAX_LOCK = 24 * 3600_000;
function readPinLocks(): Record<string, PinLock> {
  try {
    return JSON.parse(localStorage.getItem(PIN_LOCKS) ?? '{}') as Record<string, PinLock>;
  } catch {
    return {};
  }
}
function pinLock(profile: number): PinLock {
  return readPinLocks()[profile] ?? { fails: [], strikes: 0, until: 0 };
}
function savePinLock(profile: number, lock: PinLock | null) {
  const all = readPinLocks();
  if (lock) all[profile] = lock;
  else delete all[profile];
  try {
    localStorage.setItem(PIN_LOCKS, JSON.stringify(all));
  } catch {
    /* kept in memory only this session */
  }
}
const waitLabel = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
};
/**
 * Browser playbacks, downloads and offline viewings by token. Only the signed-in browser that
 * started one may control it. Offline viewings play a saved copy, so only they don't count
 * toward `MAX_REMOTE_STREAMS`.
 */
type SessionKind = 'play' | 'download' | 'offline';
const sessions = new Map<
  string,
  { session: string; profile: number; type: 'movie' | 'episode'; id: number; lastProgress: number; lastSeen: number; kind: SessionKind; convert?: boolean; lastTime?: number }
>();

const activeStreams = () => [...sessions.values()].filter((s) => s.kind !== 'offline').length;

/** Ends this browser's earlier session of the same kind (one playback, one download, one offline viewing each). */
function replaceOwn(caller: Caller, kind: SessionKind) {
  for (const [token, s] of [...sessions]) if (s.session === caller.session && s.kind === kind) stopStream(token);
}

function parseQuality(v: unknown): Partial<Quality> | undefined {
  if (v == null) return undefined;
  const q = (typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (!isQualityRes(q.res)) throw new ApiError(400, 'Unknown quality');
  if (q.level == null) return { res: q.res };
  if (!isQualityLevel(q.level)) throw new ApiError(400, 'Unknown quality');
  return { res: q.res, level: q.level };
}

function parseType(v: unknown): 'movie' | 'episode' {
  if (v === 'movie' || v === 'episode') return v;
  throw new ApiError(400, 'Unknown title type');
}

/** The picker's entries for one file, with estimated download sizes. */
function qualityOptions(row: MovieRow | EpisodeRow, choices: QualityChoices): RemoteQualityOption[] {
  const duration = durationOf(row);
  const size = (q: Quality) => (duration > 0 ? estimateBytes(conversionKbps(row, q), duration) : null);
  const original: RemoteQualityOption = {
    res: 'original',
    label: resLabel('original'),
    asIs: choices.asIs,
    sizes: { high: choices.asIs ? row.file_size || null : size({ res: 'original', level: 'high' }) },
  };
  return [
    original,
    ...choices.steps.map((res) => ({
      res,
      label: resLabel(res),
      sizes: Object.fromEntries(QUALITY_LEVELS.map((level) => [level, size({ res, level })])),
    })),
  ];
}

function mimeFor(path: string) {
  const e = path.split('.').pop()?.toLowerCase();
  return e === 'webm' ? 'video/webm' : 'video/mp4';
}

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
/** Downloads wait longer: a phone that's locked mid-download stops checking in for a while. */
export const DOWNLOAD_IDLE_MS = 30 * 60_000;

export function sweepIdleStreams(now = Date.now()) {
  for (const [token, s] of [...sessions]) if (now - s.lastSeen > (s.kind === 'download' ? DOWNLOAD_IDLE_MS : STREAM_IDLE_MS)) stopStream(token);
}

/** Ends playback that belonged to a browser that was signed out. */
export function endRemoteSession(session: string) {
  for (const [token, s] of [...sessions]) if (s.session === session) stopStream(token);
  endMusicSession(session);
}

/** "S3:E2 · Mar 4" for the next episode to air (today or later). */
function nextAirLabel(i: MediaItem): string | null {
  const n = i.nextEpisode;
  if (!n?.air_date) return null;
  const when = new Date(`${n.air_date}T12:00:00`);
  if (Number.isNaN(when.getTime())) return null;
  return `S${n.season}:E${n.episode} · ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
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
    tagline: i.tagline,
    myList: i.myList,
    watched: i.watched,
    imdbVotes: i.imdbVotes,
    badges: techBadgeList(i.tech, false, true),
    status: i.kind === 'tv' ? i.tmdbStatus : null,
    nextAir: i.kind === 'tv' ? nextAirLabel(i) : null,
    ...extra,
  };
}

/** Up to nine titles from the library that share this one's genres (the desktop's More Like This). */
function similarTo(item: MediaItem, items: MediaItem[]): MediaItem[] {
  const mine = new Set(genreBuckets(item.genres));
  if (!mine.size) return [];
  return items
    .filter((i) => i.key !== item.key && i.matched)
    .map((i) => ({ i, score: genreBuckets(i.genres).filter((g) => mine.has(g)).length * 10 + (i.kind === item.kind ? 3 : 0) + i.voteAverage / 2 }))
    .filter((x) => x.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 9)
    .map((x) => x.i);
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
  const cast = item.cast.filter((c) => !c.job);
  const crew = item.cast.filter((c) => c.job === 'Director' || c.job === 'Creator');
  const parts = item.kind === 'movie' && item.collectionId ? items.filter((i) => i.kind === 'movie' && i.collectionId === item.collectionId) : [];
  const ratings: Record<number, number> = {};
  for (const [season, r] of Object.entries(item.imdbSeasons ?? {})) if (r?.rating) ratings[Number(season)] = r.rating;
  return {
    item: lite(item),
    cast: cast.slice(0, 6).map((c) => c.name),
    play: playable(playTargetFor(item, bySeries)),
    episodes,
    people: cast.slice(0, 16).map((c) => ({ name: c.name, role: c.character || null, photo: c.profile_path ?? null })),
    crew: crew.map((c) => ({ name: c.name, role: c.job ?? null, photo: c.profile_path ?? null })),
    seasonRatings: ratings,
    similar: similarTo(item, items).map((i) => lite(i)),
    collection: parts.length > 1 ? { name: item.collectionName ?? 'Collection', items: parts.sort((a, b) => (a.year ?? 0) - (b.year ?? 0)).map((i) => lite(i)) } : null,
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
  quality?: Partial<Quality>;
}

const TOO_MANY = 'Too many devices are watching or downloading right now. Stop on another device and try again.';

/** Title, episode line, next episode and credits-scene hint shown with a playback or download. */
function describe(row: MovieRow | EpisodeRow, type: 'movie' | 'episode', items: MediaItem[], bySeries: Map<number, EpisodeRow[]>) {
  let titleText = row.title;
  let subtitle: string | null = null;
  let next: RemotePlayable | null = null;
  let stinger: RemoteStream['stinger'] = null;
  let itemKey: string | null = null;
  if (type === 'episode') {
    const e = row as EpisodeRow;
    const show = items.find((i) => i.kind === 'tv' && i.id === e.series_id);
    titleText = show?.title ?? e.title;
    itemKey = show?.key ?? null;
    subtitle = `${epLabel(e)} · ${e.title}`;
    const list = bySeries.get(e.series_id) ?? [];
    const n = list.slice(list.findIndex((x) => x.id === e.id) + 1).find((x) => x.season_number > 0);
    if (n) next = { type: 'episode', id: n.id, label: `${epLabel(n)} · ${n.title}`, resume: 0 };
  } else {
    const m = row as MovieRow;
    itemKey = items.find((i) => i.kind === 'movie' && (i.id === m.id || i.versions.some((v) => v.id === m.id)))?.key ?? null;
    if (m.stinger === 'during' || m.stinger === 'after' || m.stinger === 'both') stinger = m.stinger;
  }
  return { title: titleText, subtitle, next, stinger, itemKey };
}

async function play(caller: Caller, profile: Profile, type: 'movie' | 'episode', id: number, opts: PlayOptions = {}): Promise<RemoteStream> {
  const st = await limitStatus(profile);
  if (st.blocked) throw new ApiError(403, blockedMessage(profile, st.blocked));
  // One playback per browser: starting another replaces it.
  replaceOwn(caller, 'play');
  sweepIdleStreams();
  if (activeStreams() >= MAX_REMOTE_STREAMS) throw new ApiError(429, TOO_MANY);
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

  const defaultAid = defaultAudio?.id ?? null;
  const needsConversion = chosenSid > 0 || (chosenAid != null && defaultAid != null && chosenAid !== defaultAid);
  const choices = qualityChoices(row, needsConversion);
  const quality = resolveQuality(opts.quality, choices);
  const plan = planStream(row, 'browser', {
    aid: chosenAid,
    defaultAid,
    sid: chosenSid,
    subStyle: mpvSubStyle,
    quality,
  });
  const token = await registerStream(row.file_path, plan);
  const resume = opts.start != null ? Math.max(0, opts.start) : row.watched ? 0 : row.progress_seconds;
  const url = await streamUrl(token, plan.format === 'direct' ? 0 : resume);
  sessions.set(token, { session: caller.session, profile: profile.id, type, id, lastProgress: Date.now(), lastSeen: Date.now(), kind: 'play' });

  const { title: titleText, subtitle, next, stinger } = describe(row, type, items, bySeries);

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
    quality,
    qualities: qualityOptions(row, choices),
  };
}

/** The quality choices for one title (for the download picker). */
async function qualities(profile: Profile, type: 'movie' | 'episode', id: number): Promise<RemoteQualities> {
  const { movies, episodes, items } = await libraryFor(profile);
  const row: MovieRow | EpisodeRow | undefined = type === 'movie' ? movies.find((m) => m.id === id) : episodes.find((e) => e.id === id);
  if (!row || !allowedTitle(items, episodes, type, id)) throw new ApiError(404, 'Not found');
  const choices = qualityChoices(row);
  return { options: qualityOptions(row, choices), default: choices.default };
}

/**
 * Prepares a title for saving in the browser: the file itself when browsers play it as it is,
 * otherwise an MP4 the PC converts first. Same rating, limit and device checks as playback.
 */
async function download(caller: Caller, profile: Profile, type: 'movie' | 'episode', id: number, requested?: Partial<Quality>): Promise<RemoteDownload> {
  rateLimit(caller, 'download', 10, 60_000);
  const st = await limitStatus(profile);
  if (st.blocked) throw new ApiError(403, blockedMessage(profile, st.blocked));
  // A saved copy plays without the PC, so its time can't count toward a daily limit or bedtime.
  if (profile.daily_limit || profile.bedtime) throw new ApiError(403, 'Downloads aren’t available on profiles with a daily limit or bedtime.');
  const { movies, episodes, bySeries, items } = await libraryFor(profile);
  const row: MovieRow | EpisodeRow | undefined = type === 'movie' ? movies.find((m) => m.id === id) : episodes.find((e) => e.id === id);
  if (!row || !allowedTitle(items, episodes, type, id)) throw new ApiError(404, 'Not found');
  if (downloadBlockingPlayback(row.file_path, useLibraryStore.getState().torrents)) throw new ApiError(409, stillDownloadingMessage(row.title));
  // One download per browser at a time; the browser queues the rest.
  replaceOwn(caller, 'download');
  sweepIdleStreams();
  if (activeStreams() >= MAX_REMOTE_STREAMS) throw new ApiError(429, TOO_MANY);

  const { options, quality } = planDownload(row, requested);
  const token = await registerStream(row.file_path, options);
  let path: string;
  try {
    path = (await streamUrl(token, 0)).path;
  } catch (e) {
    releaseStream(token);
    throw e;
  }
  const convert = options.format !== 'direct';
  sessions.set(token, { session: caller.session, profile: profile.id, type, id, lastProgress: Date.now(), lastSeen: Date.now(), kind: 'download', convert });
  const duration = durationOf(row);
  const { title: titleText, subtitle, stinger, itemKey } = describe(row, type, items, bySeries);
  return {
    token,
    url: path,
    mode: convert ? 'convert' : 'file',
    mime: convert ? 'video/mp4' : mimeFor(row.file_path),
    quality,
    itemKey,
    title: titleText,
    subtitle,
    duration,
    estimate: convert ? (duration > 0 ? estimateBytes(options.bitrate ?? 0, duration) : null) : row.file_size || null,
    chapters: parseMediaInfo(row.media_info)?.chapters ?? [],
    segments: parseSegments(row.segments).map(({ kind, start, end }) => ({ kind, start, end })),
    stinger,
  };
}

async function downloadProgress(caller: Caller, token: unknown): Promise<RemoteDownloadStatus> {
  const s = ownedStream(token, caller);
  if (!s || s.kind !== 'download') throw new ApiError(404, 'This download ended. Start it again.');
  s.lastSeen = Date.now();
  if (!s.convert) return { state: 'ready', progress: 1, error: null };
  const st = await downloadStatus(String(token)).catch(() => null);
  if (!st) throw new ApiError(404, 'This download ended. Start it again.');
  // Encoder errors can mention files on the PC; browsers get a plain message.
  return { state: st.state, progress: st.progress, error: st.state === 'failed' ? 'The PC couldn’t convert this video. Try another quality.' : null };
}

/**
 * Watching a saved copy while the PC is reachable: the same limit and rating checks, and a token
 * so `/progress` credits the watch time.
 */
async function offlineStart(caller: Caller, profile: Profile, type: 'movie' | 'episode', id: number) {
  rateLimit(caller, 'offline', 20, 60_000);
  const st = await limitStatus(profile);
  if (st.blocked) throw new ApiError(403, blockedMessage(profile, st.blocked));
  if (!(await allowedRow(profile, type, id))) throw new ApiError(404, 'Not found');
  replaceOwn(caller, 'offline');
  const token = key();
  sessions.set(token, { session: caller.session, profile: profile.id, type, id, lastProgress: Date.now(), lastSeen: Date.now(), kind: 'offline' });
  return { token };
}

async function progress(caller: Caller, profile: Profile, body: { type: 'movie' | 'episode'; id: number; time: number; duration: number; watched?: number; token?: string; at?: number }) {
  const type = body.type === 'episode' ? 'episode' : 'movie';
  const id = Number(body.id);
  if (!(await allowedRow(profile, type, id))) throw new ApiError(404, 'Not found');
  const time = Math.max(0, Number(body.time) || 0);
  const duration = Math.max(0, Number(body.duration) || 0);
  // Progress saved offline arrives later, stamped with when it happened: it never replaces anything
  // watched since (finishing a film on the PC, then reconnecting the phone, used to un-finish it).
  const at = Number(body.at);
  const newer = Number.isFinite(at) && at > 0 ? await db.lastWatchedAt(profile.id, type, id) : null;
  if (newer == null || newer <= at) await db.recordProgress(type, id, time, duration, profile.id);
  // Watch time counts toward daily limits; credit no more than the real time since the last report.
  const stream = ownedStream(body.token, caller);
  let watched = 0;
  if (stream && stream.profile === profile.id && stream.type === type && stream.id === id) {
    const now = Date.now();
    const cap = Math.min((now - stream.lastProgress) / 1000 + 5, 120);
    // Credited from what the browser says it watched, or from how far the video actually moved,
    // whichever is more: a browser reporting nothing no longer gets unlimited screen time.
    const reported = Math.max(0, Number(body.watched) || 0);
    const moved = stream.lastTime != null ? Math.abs(time - stream.lastTime) : 0;
    watched = Math.min(Math.max(reported, moved), cap);
    stream.lastTime = time;
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
  const lock = pinLock(profile.id);
  if (lock.until > now) throw new ApiError(429, `Too many wrong PINs. Try again in ${waitLabel(lock.until - now)}.`);
  if (profile.pin) {
    // Counted before the (slow, async) check so parallel guesses can't slip past the lockout.
    lock.fails = lock.fails.filter((t) => now - t < PIN_LOCKOUT).concat(now);
    if (lock.fails.length >= PIN_TRIES) {
      lock.strikes += 1;
      lock.until = now + Math.min(PIN_MAX_LOCK, PIN_LOCKOUT * 4 ** (lock.strikes - 1));
      lock.fails = [];
    }
    savePinLock(profile.id, lock);
    if (!(await verifyPin(profile.pin, String(body.pin ?? '')))) {
      await new Promise((r) => setTimeout(r, 600));
      // The PC owner hears about it: a child guessing a parent's PIN shouldn't go unnoticed.
      useLibraryStore.getState().toast(`A wrong PIN was entered for ${profile.name} on a connected device`, 'info');
      if (lock.until > now) throw new ApiError(403, `Too many wrong PINs. Try again in ${waitLabel(lock.until - now)}.`);
      const left = PIN_TRIES - lock.fails.length;
      throw new ApiError(403, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    }
  }
  savePinLock(profile.id, null);
  const keys = unlocked.get(profile.id) ?? new Map<string, { pin: string; expires: number }>();
  for (const [k, v] of keys) if (v.expires < now) keys.delete(k);
  const k = key();
  keys.set(k, { pin: profile.pin, expires: now + UNLOCK_TTL });
  unlocked.set(profile.id, keys);
  return { key: k };
}

/** "Play on PC": the same rating, limit and download checks as browser playback, then the desktop player. */
async function playOnPc(caller: Caller, profile: Profile, type: 'movie' | 'episode', id: number) {
  rateLimit(caller, 'play', 6, 60_000);
  const st = await limitStatus(profile);
  if (st.blocked) throw new ApiError(403, blockedMessage(profile, st.blocked));
  const { movies, episodes, items } = await libraryFor(profile);
  const row: MovieRow | EpisodeRow | undefined = type === 'movie' ? movies.find((m) => m.id === id) : episodes.find((e) => e.id === id);
  if (!row || !allowedTitle(items, episodes, type, id)) throw new ApiError(404, 'Not found');
  if (downloadBlockingPlayback(row.file_path, useLibraryStore.getState().torrents)) throw new ApiError(409, stillDownloadingMessage(row.title));
  let target: PlayTarget;
  if (type === 'episode') {
    const e = row as EpisodeRow;
    target = episodeTarget(e, items.find((i) => i.kind === 'tv' && i.id === e.series_id) ?? { title: e.title });
  } else {
    target = { type, id, filePath: row.file_path, startTime: row.watched ? 0 : row.progress_seconds, label: row.title };
  }
  return startOnPc(caller, profile, target);
}

function liveChannel(playlist: LivePlaylist, channel: LiveChannel): RemoteLiveChannel {
  return {
    playlistId: playlist.id,
    id: channel.id,
    name: channel.name,
    group: channel.group,
    source: playlist.name,
    kind: channel.web ? 'web' : 'm3u',
    web: channel.web ? webPlayerUrl(channel.web.url) : null,
  };
}

function liveProfile(profile: Profile) {
  if (profile.maturity !== 'all') throw new ApiError(403, 'Live channels have no verified age ratings. Use an unrestricted profile for Live TV.');
}

async function todaysEvents() {
  const results = await Promise.allSettled(LEAGUES.map(([league]) => sportsSchedule(league, localDate())));
  const events = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value.events : []))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { events, partial: results.some((r) => r.status === 'rejected') };
}

/** Today's games with the channels that carry them, and every available channel. */
async function live(profile: Profile): Promise<RemoteLive> {
  liveProfile(profile);
  const [playlists, preferences, schedule] = await Promise.all([
    db.readLiveData<LivePlaylist[]>('playlists', []),
    db.readLiveData<Partial<LivePreferences>>(`profile:${profile.id}`, {}),
    todaysEvents(),
  ]);
  const order = { live: 0, upcoming: 1, finished: 2 } as const;
  return {
    events: schedule.events
      .sort((a, b) => order[a.status] - order[b.status])
      .map((event) => ({
        id: event.id,
        name: event.name,
        league: event.league,
        leagueLabel: LEAGUES.find(([id]) => id === event.league)?.[1] ?? event.league,
        date: event.date,
        status: event.status,
        detail: event.detail,
        broadcasts: event.broadcasts,
        teams: event.teams.map(({ name, abbreviation, score, color, logo, rank }) => ({ name, abbreviation, score, color, logo, rank })),
        channels: eventMatches(event, playlists, false, preferences.matches ?? {}).map((m) => liveChannel(m.playlist, m.channel)),
      })),
    channels: playlists
      .flatMap((playlist) => playlist.channels.filter((c) => playlist.health[c.id]?.state !== 'unavailable').map((c) => liveChannel(playlist, c)))
      .slice(0, 1000),
    partial: schedule.partial,
    leagues: LEAGUES.map(([id, label]) => [id, label] as [string, string]),
  };
}

/** Plays a Live TV channel on the PC (M3U channels can't be played in a browser). */
async function liveOnPc(caller: Caller, profile: Profile, playlistId: string, channelId: string, eventId: string | undefined) {
  liveProfile(profile);
  const store = useLibraryStore.getState();
  if (store.activeProfile?.id !== profile.id)
    throw new ApiError(403, store.activeProfile ? `The PC is using ${store.activeProfile.name}’s profile. Switch to ${profile.name} there to play.` : `Pick ${profile.name}’s profile on the PC first.`);
  if (useLiveStore.getState().profileId !== profile.id || !useLiveStore.getState().ready) await initLive(profile.id);
  const match = findLiveChannel(playlistId, channelId);
  if (!match) throw new ApiError(404, 'This channel is no longer in your sources');
  const event = eventId ? (await todaysEvents()).events.find((e) => e.id === eventId) : undefined;
  noteController(caller);
  await Promise.race([playLive(match, event), new Promise((r) => setTimeout(r, 8000))]);
  return { ok: true };
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
      quality: parseQuality(body.quality),
    });
  }
  if (method === 'GET' && path === '/qualities') return qualities(p(), parseType(query.type), Number(query.id));
  if (method === 'POST' && path === '/download') return download(caller, p(), parseType(body.type), Number(body.id), parseQuality(body.quality));
  if (method === 'GET' && path === '/download/status') {
    rateLimit(caller, 'download-status', 120, 60_000);
    return downloadProgress(caller, query.token);
  }
  if (method === 'POST' && path === '/offline/start') return offlineStart(caller, p(), parseType(body.type), Number(body.id));
  if (method === 'POST' && path === '/seek') {
    const s = ownedStream(body.token, caller);
    if (!s || s.kind !== 'play') throw new ApiError(404, 'Playback ended');
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
  if (method === 'GET' && path === '/remote/state') {
    rateLimit(caller, 'state', 40, 10_000);
    return nowPlaying(caller, p());
  }
  if (method === 'POST' && path === '/remote/command') return remoteCommand(caller, p(), body.action as never, body.value);
  if (method === 'GET' && path === '/live') {
    rateLimit(caller, 'live', 20, 60_000);
    return live(p());
  }
  if (method === 'POST' && path === '/live/pc') {
    rateLimit(caller, 'live-pc', 10, 60_000);
    return liveOnPc(caller, p(), String(body.playlistId ?? ''), String(body.id ?? ''), body.eventId ? String(body.eventId) : undefined);
  }
  if (method === 'POST' && path === '/remote/play') return playOnPc(caller, p(), body.type === 'episode' ? 'episode' : 'movie', Number(body.id));
  if (path.startsWith('/music/')) return musicRoute(caller, p(), method, path, query, body);
  if (path.startsWith('/together/')) {
    const res = await togetherRoute(caller, method, path, query, body, p);
    if (res !== undefined) return res;
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
  await listen<{ id: number; method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | null; session: string; device: string; pc?: string }>('remote-api', async ({ payload }) => {
    let status = 200;
    let body: unknown;
    try {
      const caller: Caller = { session: payload.session, device: payload.device, pc: payload.pc };
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
