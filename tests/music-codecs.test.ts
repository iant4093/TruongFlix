import { describe, expect, it } from 'vitest';
import { playableCodecs, roughFlacSeeking } from '../src/music/api';

const everything = { canPlayType: () => 'maybe' };

describe('which music a player is sent as-is', () => {
  it('sends Safari lossless ALAC instead of FLAC (it seeks in FLAC only roughly)', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    expect(roughFlacSeeking(iphone, 5)).toBe(true);
    expect(playableCodecs(everything, true)).not.toContain('flac');
    expect(playableCodecs(everything, true)).toContain('alac');
  });

  it('keeps FLAC for Chrome, Edge and the Windows app', () => {
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
    const android = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
    expect(roughFlacSeeking(edge, 0)).toBe(false);
    expect(roughFlacSeeking(android, 5)).toBe(false);
    expect(playableCodecs(everything, false)).toContain('flac');
  });
});
