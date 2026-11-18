/** The same TMDB image at another of its sizes ("w780", "w1280", "original"). */
const sized = (url: string, size: string) => url.replace(/\/t\/p\/[^/]+\//, `/t/p/${size}/`);

/**
 * A TMDB backdrop (or episode still) at each size TMDB has, for an image's `srcSet`: the browser
 * picks the smallest that's sharp at the size it's shown on this screen. Backdrops are stored at
 * 1280 px, which looked soft filling a big or high-DPI screen. Other images: undefined.
 */
export function backdropSrcSet(url: string | null | undefined): string | undefined {
  if (!url || !/^https:\/\/image\.tmdb\.org\/t\/p\/[^/]+\//.test(url)) return undefined;
  return `${sized(url, 'w780')} 780w, ${sized(url, 'w1280')} 1280w, ${sized(url, 'original')} 1920w`;
}
