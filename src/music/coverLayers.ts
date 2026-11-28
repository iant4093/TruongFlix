/**
 * The pictures stacked in an album cover while the next song's art fades in (see `Cover`).
 *
 * Each picture keeps its own <img> from the moment it's asked for until it's covered, so none of
 * them ever changes its `src`: swapping the `src` of the picture underneath, once the new one had
 * faded in, left a frame with nothing decoded (the placeholder, or the previous cover, flashed).
 */
export interface CoverLayer {
  src: string;
  /** Opaque: loaded and decoded (or the first picture, which simply draws as it loads). */
  shown: boolean;
}

/** Layers for a component that starts out showing `url`. */
export function initialLayers(url: string | null): CoverLayer[] {
  return url ? [{ src: url, shown: true }] : [];
}

/** `url` is now the cover: it goes on top, hidden until it has loaded (`layerShown`). */
export function addLayer(layers: CoverLayer[], url: string | null): CoverLayer[] {
  if (!url) return [];
  if (layers.at(-1)?.src === url) return layers;
  // Back to a picture still on screen (skipped forward and back again): drop what's above it.
  const visible = layers.findIndex((l) => l.src === url && l.shown);
  if (visible >= 0) return layers.slice(0, visible + 1);
  // Pictures that never loaded are invisible: no need to keep them. Two visible ones are enough
  // underneath (one still fading in over the other).
  return [...layers.filter((l) => l.shown).slice(-2), { src: url, shown: false }];
}

/** `src` has loaded and decoded: it fades in over the layers below. */
export function layerShown(layers: CoverLayer[], src: string): CoverLayer[] {
  return layers.map((l) => (l.src === src && !l.shown ? { ...l, shown: true } : l));
}

/** `src` has finished fading in: the layers under it are covered and can go. */
export function layerCovered(layers: CoverLayer[], src: string): CoverLayer[] {
  const at = layers.findIndex((l) => l.src === src && l.shown);
  return at > 0 ? layers.slice(at) : layers;
}

/** `src` couldn't be loaded. */
export function layerFailed(layers: CoverLayer[], src: string): CoverLayer[] {
  return layers.filter((l) => l.src !== src);
}
