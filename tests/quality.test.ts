import { describe, expect, it, vi } from 'vitest';
import { movie } from './fixtures';
import type { MovieRow } from '../src/types/media';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const { planDownload, planStream, qualityChoices, qualitySteps, resolveQuality } = await import('../src/services/streaming');
const { BITRATES, estimateBytes, isQualityLevel, isQualityRes, qualityLabel } = await import('../src/lib/quality');

function file(path: string, width: number, height: number, patch: Record<string, unknown> = {}): MovieRow {
  const info = {
    duration: 6000,
    width,
    height,
    video_codec: 'h264',
    video_profile: null,
    gamma: null,
    primaries: null,
    dv_profile: null,
    audio: [{ lang: 'eng', title: null, codec: 'aac', profile: null, channels: 2, default: true }],
    subs: [],
    chapters: [],
    ...patch,
  };
  return { ...movie, file_path: path, media_info: JSON.stringify(info) } as MovieRow;
}

const hdr4k = file('/Movies/Big.mkv', 3840, 2160, { video_codec: 'hevc', gamma: 'pq' });
const web1080 = file('/Movies/Web.mp4', 1920, 1080);
const scope4k = file('/Movies/Scope.mkv', 3840, 1600, { video_codec: 'hevc' });
const tiny = file('/Movies/Old.avi', 640, 360, { video_codec: 'mpeg4' });
const unknown = { ...movie, file_path: '/Movies/Mystery.mkv', media_info: null } as MovieRow;

describe('quality choices', () => {
  it('offers only resolutions at or below the source', () => {
    expect(qualityChoices(hdr4k).steps).toEqual(['2160', '1080', '720', '480']);
    expect(qualityChoices(web1080).steps).toEqual(['1080', '720', '480']);
    // A wide 4K film is 4K even though it is only 1600 lines tall.
    expect(qualityChoices(scope4k).steps).toEqual(['2160', '1080', '720', '480']);
    expect(qualitySteps({ ...JSON.parse(web1080.media_info!), width: 1920, height: 800 })).toEqual(['1080', '720', '480']);
    expect(qualityChoices(tiny).steps).toEqual([]);
    // Unmeasured files are treated as 1080p, as before.
    expect(qualityChoices(unknown).steps).toEqual(['1080', '720', '480']);
  });

  it('defaults to Original when the browser plays the file, otherwise 1080p High', () => {
    expect(qualityChoices(web1080)).toMatchObject({ asIs: true, default: { res: 'original' } });
    expect(qualityChoices(hdr4k)).toMatchObject({ asIs: false, default: { res: '1080', level: 'high' } });
    expect(qualityChoices(tiny)).toMatchObject({ asIs: false, default: { res: 'original' } });
    // Burned-in subtitles mean Original has to be converted.
    expect(qualityChoices(web1080, true).asIs).toBe(false);
  });

  it('steps a remembered quality down to what the source has', () => {
    const c = qualityChoices(web1080);
    expect(resolveQuality({ res: '2160', level: 'low' }, c)).toEqual({ res: '1080', level: 'low' });
    expect(resolveQuality({ res: '720', level: 'medium' }, c)).toEqual({ res: '720', level: 'medium' });
    expect(resolveQuality({ res: '720' }, c)).toEqual({ res: '720', level: 'high' });
    expect(resolveQuality({ res: '480', level: 'low' }, qualityChoices(tiny))).toEqual({ res: 'original', level: 'high' });
    expect(resolveQuality(undefined, c)).toEqual(c.default);
    expect(resolveQuality({ res: '8k' as never }, c)).toEqual(c.default);
    expect(resolveQuality({ res: '1080', level: 'ultra' as never }, c)).toEqual({ res: '1080', level: 'high' });
  });
});

describe('planStream for browsers', () => {
  it('never converts above the source', () => {
    const plan = planStream(web1080, 'browser', { quality: { res: '2160', level: 'high' } });
    expect(plan).toMatchObject({ format: 'hls', width: 1920, height: 1080, bitrate: BITRATES['1080'].high });
    const wide = planStream(scope4k, 'browser', { quality: { res: '720', level: 'high' } });
    expect(wide).toMatchObject({ width: 1280, height: 534 });
  });

  it('sends Original as it is only when the browser can play it', () => {
    expect(planStream(web1080, 'browser', { quality: { res: 'original' } }).format).toBe('direct');
    // Not playable: converted at full size with the highest bitrate, never passed off as-is.
    expect(planStream(hdr4k, 'browser', { quality: { res: 'original' } })).toMatchObject({
      format: 'hls',
      width: 3840,
      height: 2160,
      tone_map: true,
      bitrate: 35000,
      maxrate: 52500,
    });
    // Subtitles burned in: Original converts at the source size.
    expect(planStream(web1080, 'browser', { quality: { res: 'original' }, sid: 3 })).toMatchObject({ format: 'hls', width: 1920, height: 1080, sid: 3 });
    // Unknown size: keep whatever the file has.
    expect(planStream(unknown, 'browser', { quality: { res: 'original' } })).toMatchObject({ format: 'hls', width: 0, height: 0 });
  });

  it('uses each bitrate level', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const plan = planStream(hdr4k, 'browser', { quality: { res: '1080', level } });
      expect(plan.bitrate).toBe(BITRATES['1080'][level]);
      expect(plan.maxrate).toBe(Math.round(BITRATES['1080'][level] * 1.5));
    }
    expect(BITRATES['2160']).toEqual({ low: 12000, medium: 20000, high: 35000 });
    expect(BITRATES['480']).toEqual({ low: 800, medium: 1200, high: 2000 });
    expect(planStream(hdr4k, 'browser', { quality: { res: '2160', level: 'medium' } })).toMatchObject({ width: 3840, height: 2160, bitrate: 20000 });
  });

  it('keeps the old behaviour for TVs and browsers that pick nothing', () => {
    expect(planStream(hdr4k, 'chromecast')).toEqual({ format: 'hls', width: 1920, height: 1080, tone_map: true, aid: null, sid: null, sub_style: [] });
    expect(planStream(hdr4k, 'browser').bitrate).toBeUndefined();
    expect(planStream(web1080, 'browser').format).toBe('direct');
  });
});

describe('planDownload', () => {
  it('saves the file itself when browsers play it, otherwise one MP4', () => {
    expect(planDownload(web1080)).toMatchObject({ options: { format: 'direct' }, quality: { res: 'original' } });
    expect(planDownload(web1080, { res: '720', level: 'medium' })).toMatchObject({ options: { format: 'mp4', width: 1280, height: 720, bitrate: 3000 } });
    expect(planDownload(hdr4k)).toMatchObject({ options: { format: 'mp4', width: 1920, height: 1080, tone_map: true, aid: null, sid: null }, quality: { res: '1080', level: 'high' } });
    expect(planDownload(hdr4k, { res: 'original' })).toMatchObject({ options: { format: 'mp4', width: 3840, height: 2160, bitrate: 35000 } });
  });
});

describe('quality labels and checks', () => {
  it('names qualities without numbers and only accepts known values', () => {
    expect(qualityLabel({ res: '2160', level: 'low' })).toBe('4K · Low');
    expect(qualityLabel({ res: 'original', level: 'high' })).toBe('Original');
    expect(['original', '2160', '1080', '720', '480'].every(isQualityRes)).toBe(true);
    expect([1080, '1440', 'toString', '', null].some(isQualityRes)).toBe(false);
    expect(isQualityLevel('medium') && !isQualityLevel('max') && !isQualityLevel('constructor')).toBe(true);
    // 2 h at 6 Mbit/s video + 192 kbit/s audio.
    expect(estimateBytes(6000, 7200)).toBe(5_572_800_000);
  });
});
