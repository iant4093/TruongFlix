interface Props {
  /** What sits under the picture: a dialog panel (`surface`) or the page itself (`page`). */
  to?: 'surface' | 'page';
  /** How much of the picture's height the fade covers, as a CSS length. */
  height?: string;
  /** Darkening from the left edge behind the title and buttons (0 = none). */
  side?: number;
}

/**
 * The scrims over a backdrop picture: an optional darkening from the left for the copy, then a
 * tall fade into the exact colour below. The side scrim is drawn first so the fade covers it at
 * the bottom edge; drawn on top, it left the picture's last row darker than the panel: a seam.
 */
export default function BackdropFade({ to = 'surface', height = '70%', side = 0.4 }: Props) {
  return (
    <>
      {side > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: `linear-gradient(to right, rgba(0,0,0,${side}), transparent 50%)` }}
        />
      )}
      <div aria-hidden className={`nf-backdrop-fade ${to === 'page' ? 'nf-fade-page' : ''}`} style={{ height: `calc(${height} + 1px)` }} />
    </>
  );
}
