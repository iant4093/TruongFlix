export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'instant' : 'smooth';
}

export function reveal(element: HTMLElement | null, block: ScrollLogicalPosition = 'nearest') {
  element?.scrollIntoView?.({ behavior: scrollBehavior(), block, inline: 'nearest' });
}

export function focusAndReveal(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
  reveal(element);
}
