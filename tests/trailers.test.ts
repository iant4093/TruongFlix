import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { resolveTrailer } from '../src/services/trailers';
import { getTrailerCandidates } from '../src/services/tmdb';
import { buildItems } from '../src/store/selectors';
import { movie } from './fixtures';
import { trailerInsets } from '../src/services/trailerFrame';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (s: string) => s }));
vi.mock('../src/services/tmdb', () => ({ getTrailerCandidates: vi.fn() }));
const item = { ...buildItems([movie], [], new Map())[0], tmdbId: 603, trailerKey: 'abcdefghijk' };
const source = { videoUrl: 'http://127.0.0.1:1234/media/token/video', audioUrl: 'http://127.0.0.1:1234/media/token/audio', width: 1920, height: 1080 };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(invoke).mockResolvedValue(source); });
afterEach(() => vi.restoreAllMocks());

it('reuses concurrent resolution and requests a fresh source only for an explicit retry', async () => {
  const first = resolveTrailer(item);
  const second = resolveTrailer(item);
  expect(first).toBe(second);
  expect(await first).toEqual(source);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(getTrailerCandidates).not.toHaveBeenCalled();
  await resolveTrailer(item, true);
  expect(invoke).toHaveBeenLastCalledWith('trailer_resolve', { key: item.trailerKey, refresh: true, progressive: false });
});

it('resolves a combined source independently of an in-flight adaptive request', async () => {
  const combined = { ...source, audioUrl: null, height: 360 };
  vi.mocked(invoke).mockResolvedValueOnce(source).mockResolvedValueOnce(combined);
  const adaptive = resolveTrailer(item);
  const fallback = resolveTrailer(item, false, true);
  expect(await adaptive).toBe(source);
  expect(await fallback).toBe(combined);
  expect(invoke).toHaveBeenLastCalledWith('trailer_resolve', { key: item.trailerKey, refresh: false, progressive: true });
});

it('tries another trailer when a stored video was removed or restricted', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Unavailable'));
  vi.mocked(getTrailerCandidates).mockResolvedValue(['abcdefghijk', '12345678901']);
  expect(await resolveTrailer(item)).toEqual(source);
  expect(getTrailerCandidates).toHaveBeenCalledWith('movie', 603);
  expect(invoke).toHaveBeenLastCalledWith('trailer_resolve', { key: '12345678901', refresh: false, progressive: false });
});

it('bounds alternative lookup and allows a later retry after all sources fail', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('Unavailable'));
  vi.mocked(getTrailerCandidates).mockResolvedValue(['11111111111', '22222222222', '33333333333']);
  await expect(resolveTrailer(item)).rejects.toThrow('No available trailer');
  expect(invoke).toHaveBeenCalledTimes(3);
  vi.mocked(invoke).mockResolvedValue(source);
  expect(await resolveTrailer(item, true)).toEqual(source);
});

function picture(left: number, right: number, top: number, bottom: number) {
  const pixels = new Uint8ClampedArray(160 * 90 * 4);
  for (let y = top; y < 90 - bottom; y++) for (let x = left; x < 160 - right; x++) {
    const offset = (y * 160 + x) * 4;
    pixels.set([110, 120, 130, 255], offset);
  }
  return pixels;
}
it('removes encoded pillarboxes without stretching the picture', () => {
  expect(trailerInsets(picture(20, 20, 0, 0), 160, 90)).toEqual({ x: 0.125, y: 0 });
});
it('detects paired cinematic letterbox bars', () => {
  expect(trailerInsets(picture(0, 0, 10, 10), 160, 90)).toEqual({ x: 0, y: 10 / 90 });
});
it('keeps an ordinary frame and asymmetric dark scenery intact', () => {
  expect(trailerInsets(picture(0, 0, 0, 0), 160, 90)).toEqual({ x: 0, y: 0 });
  expect(trailerInsets(picture(20, 0, 0, 0), 160, 90)).toEqual({ x: 0, y: 0 });
});
it('does not turn a black opening frame into an extreme crop', () => {
  expect(trailerInsets(new Uint8ClampedArray(160 * 90 * 4), 160, 90)).toEqual({ x: 0, y: 0 });
});
