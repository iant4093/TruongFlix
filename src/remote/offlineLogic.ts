/** Pure helpers for saving titles in the browser (no IndexedDB or network here). */
import { formatBytes } from '../lib/format';
import type { Quality } from '../lib/quality';
import type { RemoteChapter, RemoteSegment } from './types';

/** Bytes fetched and stored per request. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Free space kept beyond the download itself; browsers refuse writes near their limit. */
export const SPACE_MARGIN = 64 * 1024 * 1024;
export const STORAGE_FULL = 'This device ran out of storage space. Delete some downloads, then tap Resume.';
export const INTERRUPTED = 'The download was interrupted. Check the connection to your PC, then tap Resume.';

export type OfflineState = 'queued' | 'preparing' | 'downloading' | 'paused' | 'failed' | 'done';

/** A saved (or saving) title. Its bytes are stored separately in numbered chunks. */
export interface OfflineItem {
  /** `${profile}:${type}:${mediaId}` */
  id: string;
  profile: number;
  /** Unlock key for a PIN-protected profile, at the time of saving. */
  profileKey?: string;
  type: 'movie' | 'episode';
  mediaId: number;
  itemKey: string | null;
  title: string;
  subtitle: string | null;
  /** What was asked for; `quality` is what the PC is sending. */
  requested: Partial<Quality>;
  quality: Quality | null;
  /** 'file': the original file; 'convert': an MP4 converted on the PC. */
  mode: 'file' | 'convert' | null;
  mime: string;
  duration: number;
  chapters: RemoteChapter[];
  segments: RemoteSegment[];
  stinger: 'during' | 'after' | 'both' | null;
  /** Full size in bytes once the PC has said. */
  total: number | null;
  bytes: number;
  chunks: number;
  state: OfflineState;
  /** Conversion progress on the PC, 0–1. */
  prepare: number;
  error: string | null;
  createdAt: number;
  /** Where offline playback stopped (seconds). */
  position: number;
  /** The PC's conversion for this download, kept while paused: resuming soon after (the phone
   * slept, Wi-Fi dropped) carries on from the saved bytes instead of converting from 0%. */
  job?: { token: string; url: string } | null;
}

/** Progress from offline playback, sent to the PC when it can be reached. */
export interface PendingProgress {
  key: string;
  profile: number;
  profileKey?: string;
  type: 'movie' | 'episode';
  id: number;
  time: number;
  duration: number;
  at: number;
}

export const downloadId = (profile: number, type: 'movie' | 'episode', id: number) => `${profile}:${type}:${id}`;
export const progressKey = (p: { profile: number; type: string; id: number }) => `${p.profile}:${p.type}:${p.id}`;

export function newItem(fields: Pick<OfflineItem, 'profile' | 'profileKey' | 'type' | 'mediaId' | 'title' | 'subtitle' | 'requested'> & { itemKey?: string | null }): OfflineItem {
  return {
    id: downloadId(fields.profile, fields.type, fields.mediaId),
    itemKey: null,
    quality: null,
    mode: null,
    mime: 'video/mp4',
    duration: 0,
    chapters: [],
    segments: [],
    stinger: null,
    total: null,
    bytes: 0,
    chunks: 0,
    state: 'queued',
    prepare: 0,
    error: null,
    createdAt: Date.now(),
    position: 0,
    ...fields,
  };
}

/** `Content-Range: bytes 0-99/1234` */
export function parseContentRange(header: string | null | undefined): { start: number; end: number; total: number | null } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((header ?? '').trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end < start) return null;
  return { start, end, total: m[3] === '*' ? null : Number(m[3]) };
}

/** The next byte range to fetch, or null once everything is stored. */
export function nextRange(have: number, total: number | null, chunk = CHUNK_BYTES): { start: number; end: number } | null {
  if (total != null && have >= total) return null;
  const end = have + chunk - 1;
  return { start: have, end: total != null ? Math.min(end, total - 1) : end };
}

export interface SpaceEstimate {
  quota?: number;
  usage?: number;
}

/** A message when `needed` more bytes won't fit; null when they fit or the browser doesn't say. */
export function spaceProblem(estimate: SpaceEstimate | null | undefined, needed: number): string | null {
  if (!estimate || estimate.quota == null || !(needed > 0)) return null;
  const free = Math.max(0, estimate.quota - (estimate.usage ?? 0));
  if (needed + SPACE_MARGIN <= free) return null;
  return `Not enough storage on this device. This download needs about ${formatBytes(needed)}, and ${formatBytes(free)} is free. Delete some downloads or pick a lower quality.`;
}

export function isQuotaError(e: unknown): boolean {
  const err = e as { name?: string; code?: number } | null;
  return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22);
}

/** Wait before retry `attempt` (1-based): 1 s, 2 s, 4 s … up to 30 s. */
export const retryDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));

/** Latest position wins for each title. */
export function mergeProgress(queue: PendingProgress[], entry: PendingProgress): PendingProgress[] {
  return [...queue.filter((p) => p.key !== entry.key), entry];
}

/** 0–1 for progress bars: conversion on the PC first, then the transfer. */
export function downloadFraction(item: Pick<OfflineItem, 'state' | 'prepare' | 'bytes' | 'total'>): number {
  if (item.state === 'done') return 1;
  if (item.state === 'preparing') return item.prepare;
  return item.total ? Math.min(1, item.bytes / item.total) : 0;
}

export function statusText(item: OfflineItem): string {
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  switch (item.state) {
    case 'queued':
      return 'Waiting';
    case 'preparing':
      return `Preparing on your PC · ${pct(item.prepare)}`;
    case 'downloading':
      return `Downloading · ${pct(downloadFraction(item))}`;
    case 'paused':
      return item.error ?? `Paused · ${pct(downloadFraction(item))}`;
    case 'failed':
      return item.error ?? 'Download failed';
    case 'done':
      return formatBytes(item.total ?? item.bytes);
  }
}
