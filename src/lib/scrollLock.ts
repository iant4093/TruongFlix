/**
 * Stops the page scrolling while something covers it (a dialog, the full-screen music player).
 *
 * Hiding the page's overflow also hides its scrollbar, which made the page ~15 px wider for as long
 * as the lock lasted: every card grew a little, then shrank back. The scrollbar's width is put back
 * as padding instead (and given to the fixed bars, which line up with the page), so nothing moves.
 * Locks nest: the page scrolls again when the last one is released.
 */
let locks = 0;

export function lockPageScroll(): () => void {
  const html = document.documentElement;
  if (locks++ === 0) {
    const gap = Math.max(0, window.innerWidth - html.clientWidth);
    html.style.setProperty('--nf-scroll-gap', `${gap}px`);
    html.classList.add('nf-scroll-locked');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) {
      html.classList.remove('nf-scroll-locked');
      html.style.removeProperty('--nf-scroll-gap');
    }
  };
}
