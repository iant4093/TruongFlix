import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { FOCUS_HOVER_DELAY_MS, HOVER_DELAY_MS, HOVER_SCALE, hoverCard } from '../../lib/motion';

export { HOVER_DELAY_MS };

export interface HoverRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const EDGE = 0.04; // matches the rows' 4% gutters
const NAV_HEIGHT = 68;

/**
 * Netflix hover intent: only call `open` after the pointer rests on the element for a moment,
 * so quick sweeps across a row never pop a card. `isOpen` lets a card dismissed by scrolling
 * reopen on the next mouse move without a new mouseenter.
 */
export function useHoverIntentCore(open: (rect: HoverRect) => void, isOpen: () => boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const cancel = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const onMouseEnter = useCallback(() => {
    cancel();
    // While navigating with arrows/a controller, the card under a resting cursor stays closed.
    if (keyboardNavigating()) return;
    timer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      timer.current = null;
      if (r.right <= 0 || r.left >= window.innerWidth || r.bottom <= NAV_HEIGHT || r.top >= window.innerHeight) return;
      openRef.current({ top: r.top, left: r.left, width: r.width, height: r.height });
    }, HOVER_DELAY_MS);
  }, [cancel]);

  const onMouseMove = useCallback(() => {
    if (timer.current == null && !isOpenRef.current()) onMouseEnter();
  }, [onMouseEnter]);

  /** TV mode: a card focused with arrows/D-pad opens its hover card once it has settled in place. */
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (!keyboardNavigating() || isOpenRef.current()) return;
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    cancel();
    const holdsFocus = (el: HTMLElement) => {
      const active = document.activeElement;
      return !!active && (el.contains(active) || active.contains(el));
    };
    const settle = (delay: number) => {
      timer.current = window.setTimeout(() => {
        const el = ref.current;
        if (!el || !holdsFocus(el) || !keyboardNavigating()) return void (timer.current = null);
        const first = el.getBoundingClientRect();
        // Wait out row paging and smooth scrolling: open only when the card has stopped moving.
        timer.current = window.setTimeout(() => {
          timer.current = null;
          if (!holdsFocus(el) || !keyboardNavigating()) return;
          const r = el.getBoundingClientRect();
          if (Math.abs(r.left - first.left) > 0.5 || Math.abs(r.top - first.top) > 0.5) return settle(120);
          if (r.right <= 0 || r.left >= window.innerWidth || r.bottom <= NAV_HEIGHT || r.top >= window.innerHeight) return;
          openRef.current({ top: r.top, left: r.left, width: r.width, height: r.height });
        }, 80);
      }, delay);
    };
    settle(FOCUS_HOVER_DELAY_MS);
  }, [cancel]);

  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) cancel();
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return { ref, onMouseEnter, onMouseMove, onMouseLeave: cancel, onFocus, onBlur };
}

/** Arrow keys or a controller drove the last input (TV mode's focus ring is showing). */
function keyboardNavigating() {
  return document.documentElement.classList.contains('tv-focus');
}

/** Only one card-local hover card is open at a time (the library one lives in the store). */
let closeOpenCard: (() => void) | null = null;

export function closeCardHoverCards() {
  closeOpenCard?.();
  closeOpenCard = null;
}

/**
 * A hover card owned by the card that opens it (Games posters, Browse titles). Opening it closes
 * any other open hover card, including the library one.
 */
export function useHoverCard() {
  const [rect, setRect] = useState<HoverRect | null>(null);
  const openRef = useRef(false);
  openRef.current = !!rect;
  const close = useCallback(() => setRect(null), []);
  const open = useCallback((next: HoverRect) => {
    if (closeOpenCard && closeOpenCard !== close) closeOpenCard();
    if (useLibraryStore.getState().hover) useLibraryStore.getState().setHover(null);
    closeOpenCard = close;
    setRect(next);
  }, [close]);
  useEffect(() => () => {
    if (closeOpenCard === close) closeOpenCard = null;
  }, [close]);
  const trigger = useHoverIntentCore(open, () => openRef.current);
  return { rect, close, trigger };
}

/** Closes a hover card when the page moves underneath it or the pointer leaves the window. */
function useDismiss(onClose: () => void) {
  useEffect(() => {
    window.addEventListener('scroll', onClose, { passive: true });
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('resize', onClose);
    document.documentElement.addEventListener('mouseleave', onClose);
    return () => {
      window.removeEventListener('scroll', onClose);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('resize', onClose);
      document.documentElement.removeEventListener('mouseleave', onClose);
    };
  }, [onClose]);
}

/**
 * The expanded hover card frame: 16:9 artwork on top, a row of round buttons, then metadata.
 * Fixed-positioned over the card it grew from, clamped at the row edges like Netflix.
 */
export function HoverCardFrame({ rect, onClose, media, onMediaClick, actions, children, label }: {
  rect: HoverRect;
  onClose: () => void;
  /** Artwork (and overlays) filling the 16:9 top area. */
  media: ReactNode;
  onMediaClick?: () => void;
  /** Round buttons; put the More Info button last (it sits at the far right). */
  actions: ReactNode;
  children?: ReactNode;
  label?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(0);
  useDismiss(onClose);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const update = () => setCardHeight(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const vw = window.innerWidth;
    // Portrait posters grow into a landscape card at least as wide as the library's.
    const base = rect.width < rect.height ? Math.max(rect.width, rect.height * 0.9) : rect.width;
    const width = Math.min(base * HOVER_SCALE, vw - 16);
    const imgH = (width * 9) / 16;
    const center = rect.left + rect.width / 2;
    let left = center - width / 2;
    let originX = 'center';
    if (rect.left < vw * EDGE + 8) {
      left = rect.left;
      originX = 'left';
    } else if (rect.left + rect.width > vw * (1 - EDGE) - 8) {
      left = rect.left + rect.width - width;
      originX = 'right';
    }
    left = Math.max(8, Math.min(left, vw - width - 8));
    const top = Math.max(NAV_HEIGHT + 4, Math.min(rect.top + rect.height / 2 - imgH / 2, window.innerHeight - cardHeight - 8));
    return { width, left, top, origin: `${originX} ${rect.top - top + rect.height / 2}px` };
  }, [rect, cardHeight]);

  return (
    <motion.div
      ref={cardRef}
      role={label ? 'group' : undefined}
      aria-label={label}
      data-hover-card=""
      onMouseLeave={onClose}
      {...hoverCard}
      style={{ position: 'fixed', top: layout.top, left: layout.left, width: layout.width, transformOrigin: layout.origin }}
      className="z-40 overflow-hidden rounded-md bg-nf-surface shadow-card"
    >
      <div className={`relative aspect-video w-full overflow-hidden bg-nf-hover ${onMediaClick ? 'cursor-pointer' : ''}`} onClick={onMediaClick}>
        {media}
      </div>
      <div className="space-y-2.5 bg-nf-surface p-[5%] pt-3">
        <div className="flex items-center gap-2">{actions}</div>
        {children}
      </div>
    </motion.div>
  );
}

/** Renders a card-local hover card into the page root, keeping it mounted through its exit. */
export function HoverCardLayer({ rect, children }: { rect: HoverRect | null; children: (rect: HoverRect) => ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (rect) setMounted(true);
  }, [rect]);
  if (!rect && !mounted) return null;
  return createPortal(
    <AnimatePresence onExitComplete={() => setMounted(false)}>
      {rect && <motion.div key={`${rect.left}:${rect.top}`} className="contents">{children(rect)}</motion.div>}
    </AnimatePresence>,
    document.body,
  );
}

const ROUND = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** A round hover-card button: `primary` is the white Play/Download disc, the rest are outlined. */
export function HoverButton({ label, onClick, primary = false, disabled, pressed, className = '', children }: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={primary ? `${ROUND} bg-white text-black hover:bg-white/80 ${className}` : `nf-circle-btn h-9 w-9 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function MoreInfoButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="More info" aria-label="More info" className="nf-circle-btn ml-auto h-9 w-9">
      <ChevronDown className="h-5 w-5" />
    </button>
  );
}

/** Genres separated by Netflix's small grey dots. */
export function GenreDots({ genres }: { genres: string[] }) {
  if (!genres.length) return null;
  return (
    <div className="flex flex-wrap items-center text-xs text-white">
      {genres.map((g, i) => (
        <span key={g} className="flex items-center">
          {i > 0 && <span className="mx-1.5 text-[8px] text-[#646464]">●</span>}
          {g}
        </span>
      ))}
    </div>
  );
}

/** Title treatment over hover-card artwork when there's no logo. */
export function HoverTitleOverlay({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-1/2 items-end bg-gradient-to-t from-black/60 to-transparent p-[6%]">
      {children ?? (
        <span className="line-clamp-2 text-[clamp(0.7rem,1vw,1rem)] font-bold uppercase leading-tight tracking-tight text-white drop-shadow">{title}</span>
      )}
    </div>
  );
}
