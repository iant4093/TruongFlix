import type { Variants } from 'framer-motion';

/**
 * The app's one set of motion tokens. Dialogs, cards, the hover card, billboards, toasts and
 * tab/section transitions all draw from here so timing feels the same everywhere.
 * `MotionConfig reducedMotion="user"` at the app root turns transforms off for reduced motion.
 */
export const duration = {
  /** Small state changes: highlights, presses. */
  fast: 0.15,
  /** Exits and quick fades. */
  exit: 0.18,
  /** Dialogs, cards, hover card, toasts. */
  base: 0.25,
  /** Content swaps (tabs, sections) and image fade-ins. */
  fade: 0.3,
  /** Billboard copy and artwork. */
  slow: 0.7,
} as const;

export const ease = {
  /** Netflix's standard curve. */
  standard: [0.21, 0, 0.27, 1],
  /** Decelerate into place. */
  out: [0.16, 1, 0.3, 1],
  /** Row paging. */
  slide: [0.5, 0, 0.1, 1],
} as const;

export const spring = {
  /** Sliding tab highlights. */
  highlight: { type: 'spring', stiffness: 520, damping: 42, mass: 0.9 },
} as const;

export const transition = {
  base: { duration: duration.base, ease: ease.standard },
  exit: { duration: duration.exit, ease: ease.standard },
  fade: { duration: duration.fade, ease: ease.standard },
  billboard: { duration: duration.slow, delay: 0.2 },
} as const;

/** Simple opacity fade used for tab panels and sections. */
export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transition.fade },
  exit: { opacity: 0, transition: transition.exit },
};

/** Dialog panel: rises and settles. */
export const dialogPanel: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 20 },
  animate: { opacity: 1, scale: 1, y: 0, transition: transition.base },
  exit: { opacity: 0, scale: 0.96, y: 20, transition: transition.base },
};

/** Dimmed backdrop behind dialogs and overlays. */
export const backdrop: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.2 } },
};

/** Billboard copy entering after its artwork. */
export const billboardCopy: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: transition.billboard },
};

/** Toast stack items. */
export const toast = {
  layout: 'position' as const,
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, x: 40, transition: transition.exit },
  transition: transition.base,
};

/** Hover card growth factor and timing (relative to the card it opens from). */
export const HOVER_SCALE = 1.35;
export const HOVER_DELAY_MS = 350;
/** TV mode: how long a card keeps focus before its hover card opens (quick D-pad moves skip it). */
export const FOCUS_HOVER_DELAY_MS = 650;
export const hoverCard = {
  initial: { scale: 1 / HOVER_SCALE, opacity: 0.4 },
  animate: { scale: 1, opacity: 1 },
  exit: { scale: 1 / HOVER_SCALE, opacity: 0, transition: transition.exit },
  transition: transition.base,
};
