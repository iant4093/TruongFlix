/**
 * The very soft copy of the artwork behind the full-screen player.
 *
 * The artwork is shrunk in halves (each step averages its pixels) to a handful of pixels, given more
 * colour and a little less light, then grown back in doubles (each step smooths). That blurs as
 * evenly as a huge Gaussian blur and works in every browser (Safari ignores canvas filters). Where
 * canvas filters do work (the desktop app), a real blur on top removes the last soft corners that
 * show as faint blotches on big dark screens. The grain over it (music.css) hides banding.
 */

/** The size the soft artwork is drawn at; the screen stretches it further, which stays smooth. */
export const SOFT_SIZE = 256;
/** How small the artwork is shrunk to: only its broad colours survive. */
const SOFT_CORE = 10;

function step(from: CanvasImageSource, size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(from, 0, 0, size, size);
  return c;
}

export function paintSoft(canvas: HTMLCanvasElement, image: CanvasImageSource) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let src = step(image, 128);
  for (let size = 64; src.width > SOFT_CORE; size = Math.floor(size / 2)) src = step(src, Math.max(size, SOFT_CORE));
  // Richer colours (the image overlaid on itself) and a touch darker, like Apple Music.
  const core = src.getContext('2d')!;
  core.globalAlpha = 0.55;
  core.globalCompositeOperation = 'overlay';
  core.drawImage(src, 0, 0);
  core.globalAlpha = 1;
  core.globalCompositeOperation = 'source-over';
  core.fillStyle = 'rgba(0, 0, 0, 0.22)';
  core.fillRect(0, 0, src.width, src.height);
  for (let size = src.width * 2; size < SOFT_SIZE; size *= 2) src = step(src, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, SOFT_SIZE, SOFT_SIZE);
  const blur = typeof ctx.filter === 'string';
  if (blur) ctx.filter = `blur(${Math.round(SOFT_SIZE / 24)}px)`;
  // Drawn a little past the edges, so the blur doesn't fade them.
  const pad = blur ? SOFT_SIZE / 8 : 0;
  ctx.drawImage(src, -pad, -pad, SOFT_SIZE + pad * 2, SOFT_SIZE + pad * 2);
  if (blur) ctx.filter = 'none';
}
