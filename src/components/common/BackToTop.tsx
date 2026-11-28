import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp } from 'lucide-react';
import { scrollBehavior } from '../../lib/scroll';
import { useCornerBottom } from './Toasts';

/** The button shows once the page is scrolled this many screens down. */
export const BACK_TO_TOP_SCREENS = 1.5;

export function backToTopVisible(scrollTop: number, viewportHeight: number): boolean {
  return viewportHeight > 0 && scrollTop > viewportHeight * BACK_TO_TOP_SCREENS;
}

/** The element that scrolls the pages (the root scroller: only `html` scrolls, see index.css). */
export function pageScroller(): HTMLElement {
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** Something covers the page: a dialog's scroll lock, an overlay hiding its overflow, or the full-screen player. */
function pageCovered(): boolean {
  const html = document.documentElement;
  return html.classList.contains('nf-scroll-locked') || html.classList.contains('player-mode') || html.style.overflowY === 'hidden';
}

/** Gap kept between the button and the toast stack above the same corner. */
const TOAST_GAP = 12;

/**
 * Round "back to top" button in the bottom-right corner of long pages. It sits under the toasts
 * (moving up as they stack) and above the mini player and the music and cast bars.
 */
export default function BackToTop({ scroller = pageScroller }: { scroller?: () => HTMLElement }) {
  const [scrolled, setScrolled] = useState(false);
  const [covered, setCovered] = useState(pageCovered);
  const [lift, setLift] = useState(0);
  const bottom = useCornerBottom();
  const button = useRef<HTMLButtonElement>(null);

  // How far down the page is. The root scroller reports its scrolling on window.
  useEffect(() => {
    const el = scroller();
    const root = el === document.scrollingElement || el === document.documentElement || el === document.body;
    const target: HTMLElement | Window = root ? window : el;
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(backToTopVisible(el.scrollTop, root ? window.innerHeight : el.clientHeight));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller]);

  // Dialogs, overlays and the player mark the page root while they cover it.
  useEffect(() => {
    const observer = new MutationObserver(() => setCovered(pageCovered()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);

  // Toasts share the corner: stay just under the stack.
  useEffect(() => {
    const stack = document.querySelector<HTMLElement>('[data-toast-stack]');
    if (!stack || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const height = stack.getBoundingClientRect().height;
      setLift(height > 0 ? height + TOAST_GAP : 0);
    });
    observer.observe(stack);
    return () => observer.disconnect();
  }, []);

  const toTop = () => {
    const hadFocus = document.activeElement === button.current;
    scroller().scrollTo({ top: 0, behavior: scrollBehavior() });
    // The button goes away at the top: keep keyboard focus at the top of the page with it.
    if (hadFocus) document.querySelector<HTMLElement>('[data-nav-fixed] button, [data-nav-fixed] a[href]')?.focus({ preventScroll: true });
  };

  return (
    <div
      className="pointer-events-none fixed right-6 z-50 transition-[bottom,transform] duration-300 ease-out motion-reduce:transition-none"
      style={{ bottom, transform: lift ? `translateY(-${lift}px)` : undefined }}
    >
      <AnimatePresence>
        {scrolled && !covered && (
          <motion.button
            key="back-to-top"
            ref={button}
            type="button"
            aria-label="Back to top"
            title="Back to top"
            onClick={toTop}
            initial={{ opacity: 0, y: 16, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.85 }}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className="group pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-nf-hover/90 text-white shadow-[0_8px_24px_rgba(0,0,0,0.6)] backdrop-blur transition-colors duration-200 hover:border-nf-red hover:bg-nf-red active:bg-[#b20710] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-nf-bg"
          >
            <ArrowUp aria-hidden className="h-5 w-5" strokeWidth={2.5} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
