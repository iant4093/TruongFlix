import { describe, expect, it } from 'vitest';
import { backdropSrcSet } from '../src/lib/images';

describe('backdropSrcSet', () => {
  it('offers every TMDB size so big screens get a sharp backdrop', () => {
    expect(backdropSrcSet('https://image.tmdb.org/t/p/w1280/abc.jpg')).toBe(
      'https://image.tmdb.org/t/p/w780/abc.jpg 780w, https://image.tmdb.org/t/p/w1280/abc.jpg 1280w, https://image.tmdb.org/t/p/original/abc.jpg 1920w',
    );
  });

  it('leaves other images alone', () => {
    expect(backdropSrcSet('asset://localhost/frame.jpg')).toBeUndefined();
    expect(backdropSrcSet(null)).toBeUndefined();
  });
});
