/** Detect symmetric black bars encoded into the picture, using a small decoded frame. */
export function trailerInsets(pixels: Uint8ClampedArray, width: number, height: number) {
  const dark = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return pixels[i] < 14 && pixels[i + 1] < 14 && pixels[i + 2] < 14;
  };
  const row = (y: number) => {
    let count = 0;
    for (let x = 0; x < width; x++) if (dark(x, y)) count++;
    return count >= width * 0.98;
  };
  const column = (x: number) => {
    let count = 0;
    for (let y = 0; y < height; y++) if (dark(x, y)) count++;
    return count >= height * 0.98;
  };
  let left = 0, right = 0, top = 0, bottom = 0;
  while (left < width / 4 && column(left)) left++;
  while (right < width / 4 && column(width - right - 1)) right++;
  while (top < height / 4 && row(top)) top++;
  while (bottom < height / 4 && row(height - bottom - 1)) bottom++;
  const paired = (a: number, b: number, size: number) =>
    Math.abs(a - b) <= 2 && a >= size * 0.025 && a < size / 4 ? Math.min(a, b) / size : 0;
  return { x: paired(left, right, width), y: paired(top, bottom, height) };
}
