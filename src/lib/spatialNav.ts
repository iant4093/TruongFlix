/**
 * Spatial navigation for TV mode: arrow keys / D-pad move focus to the nearest focusable element
 * in that direction, confined to the top dialog layer. Rows (`data-nav-row`) keep horizontal moves
 * inside the row and page it at the edges; each row remembers its last focused card.
 *
 * Markup hooks:
 * - `data-nav-row`      a carousel/row; receives a cancelable `spatialnav:edge` event at its ends.
 * - `data-nav-fixed`    fixed chrome (the navbar); measured in viewport space, never scrolled to.
 * - `data-nav-skip`     never a target (toasts, hidden chevrons).
 * - `data-nav-autofocus` preferred first target when nothing is focused in a scope.
 * - `data-hover-card`   an expanded hover card; only reachable from the card under it.
 */

import { scrollBehavior } from './scroll';

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const EDGE_EVENT = 'spatialnav:edge';
export type EdgeEventDetail = { direction: Direction; from: HTMLElement };

const horizontal = (dir: Direction) => dir === 'left' || dir === 'right';
const cx = (b: Box) => (b.left + b.right) / 2;
const cy = (b: Box) => (b.top + b.bottom) / 2;

/** Is `to` past `from` in `dir`? (Centre beyond, and its near edge not behind ours.) */
export function isInDirection(from: Box, to: Box, dir: Direction): boolean {
  switch (dir) {
    case 'right': return cx(to) > cx(from) + 0.5 && to.left > from.left + 0.5;
    case 'left': return cx(to) < cx(from) - 0.5 && to.right < from.right - 0.5;
    case 'down': return cy(to) > cy(from) + 0.5 && to.top > from.top + 0.5;
    case 'up': return cy(to) < cy(from) - 0.5 && to.bottom < from.bottom - 0.5;
  }
}

function gap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, b0 - a1, a0 - b1);
}

/**
 * Lower is better. The distance along the direction counts once; being out of line on the
 * other axis counts heavily, so the next card in the same row (or the card right below) wins.
 * `anchor` is a remembered column (x) or line (y) used instead of the origin's own range.
 */
export function score(from: Box, to: Box, dir: Direction, anchor?: number): number {
  const primary = dir === 'right' ? to.left - from.right
    : dir === 'left' ? from.left - to.right
      : dir === 'down' ? to.top - from.bottom
        : from.top - to.bottom;
  const along = Math.max(0, primary);
  let ortho: number;
  let offset: number;
  if (horizontal(dir)) {
    ortho = anchor != null ? gap(anchor, anchor, to.top, to.bottom) : gap(from.top, from.bottom, to.top, to.bottom);
    offset = Math.abs((anchor ?? cy(from)) - cy(to));
  } else {
    ortho = anchor != null ? gap(anchor, anchor, to.left, to.right) : gap(from.left, from.right, to.left, to.right);
    offset = Math.abs((anchor ?? cx(from)) - cx(to));
  }
  return along + ortho * 3 + offset * 0.05;
}

function primaryGap(from: Box, to: Box, dir: Direction) {
  return Math.max(0, dir === 'right' ? to.left - from.right : dir === 'left' ? from.left - to.right : dir === 'down' ? to.top - from.bottom : from.top - to.bottom);
}

/** Within a 45° cone of the direction (edge to edge), so Right never jumps far up or down. */
export function inCone(from: Box, to: Box, dir: Direction) {
  const ortho = horizontal(dir) ? gap(from.top, from.bottom, to.top, to.bottom) : gap(from.left, from.right, to.left, to.right);
  return ortho <= primaryGap(from, to, dir);
}

export function pickNearest<T>(from: Box, candidates: { item: T; box: Box }[], dir: Direction, anchor?: number, nearestLine = false): T | null {
  let ahead = candidates.filter((c) => isInDirection(from, c.box, dir));
  // Sideways moves stay within the cone; up/down prefer it but may reach further (e.g. navbar → content).
  if (horizontal(dir) || !nearestLine) {
    const coned = ahead.filter((c) => inCone(from, c.box, dir));
    if (horizontal(dir) || coned.length) ahead = coned;
  }
  if (nearestLine && !horizontal(dir) && ahead.length) {
    // Between rows, up/down always lands on the next row first, even a short one, then the closest column.
    const nearest = ahead.reduce((a, b) => (primaryGap(from, b.box, dir) < primaryGap(from, a.box, dir) ? b : a));
    const band = primaryGap(from, nearest.box, dir) + Math.max(16, (nearest.box.bottom - nearest.box.top) * 0.5);
    ahead = ahead.filter((c) => primaryGap(from, c.box, dir) <= band);
  }
  let best: T | null = null;
  let bestScore = Infinity;
  for (const c of ahead) {
    const s = score(from, c.box, dir, anchor);
    if (s < bestScore) {
      bestScore = s;
      best = c.item;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[tabindex]', '[contenteditable="true"]',
].join(',');

export interface NavHooks {
  /** Root of the top-most dialog layer, or null for the page. */
  scope: () => HTMLElement | null;
  /** Close any open hover card (focus moved away from its card). */
  closeHover: () => void;
}

let hooks: NavHooks = { scope: () => null, closeHover: () => {} };

export function configureSpatialNav(next: Partial<NavHooks>) {
  hooks = { ...hooks, ...next };
}

const rowMemory = new WeakMap<Element, HTMLElement>();
let column: { x: number; origin: HTMLElement } | null = null;
let hoverOrigin: HTMLElement | null = null;

/** Forget remembered rows/columns (tests). */
export function resetSpatialNav() {
  column = null;
  hoverOrigin = null;
}

export function scopeRoot(): HTMLElement {
  return hooks.scope() ?? document.body;
}

export function isNavigable(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.tabIndex < 0 && !el.matches('a[href], button, input, select, textarea, summary')) return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('[inert], [hidden], [aria-hidden="true"], [data-nav-skip]')) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.pointerEvents === 'none') return false;
  return true;
}

/** Page-space box: content scrolls with the page, fixed chrome (and dialog contents) stay put. */
export function boxOf(el: Element, pageScope = scopeRoot() === document.body): Box {
  const r = el.getBoundingClientRect();
  const shift = pageScope && !el.closest('[data-nav-fixed], [data-hover-card]') ? window.scrollY : 0;
  return { left: r.left, right: r.right, top: r.top + shift, bottom: r.bottom + shift };
}

export function navigableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isNavigable);
}

function inViewport(el: Element) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

/** Where focus should land when nothing in the scope is focused yet. */
export function initialTarget(root = scopeRoot(), remembered?: HTMLElement | null): HTMLElement | null {
  if (remembered && root.contains(remembered) && isNavigable(remembered)) return remembered;
  const all = navigableIn(root).filter((el) => !el.closest('[data-hover-card]'));
  const preferred = all.find((el) => el.matches('[data-nav-autofocus]') && inViewport(el));
  if (preferred) return preferred;
  const visible = all.filter((el) => inViewport(el) && !el.closest('[data-nav-fixed]'));
  // Land on content rather than a dialog's close button (Back closes it anyway).
  const content = visible.filter((el) => !/^(close|cancel)$/i.test(el.getAttribute('aria-label') ?? ''));
  const pool = content.length ? content : visible.length ? visible : all;
  return pool.slice().sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return Math.round(ra.top - rb.top) || ra.left - rb.left;
  })[0] ?? null;
}

function openHoverCardOver(el: HTMLElement): HTMLElement | null {
  const card = document.querySelector<HTMLElement>('[data-hover-card]');
  if (!card) return null;
  const a = el.getBoundingClientRect();
  const b = card.getBoundingClientRect();
  const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return overlaps ? card : null;
}

function rowOf(el: Element | null) {
  return el?.closest<HTMLElement>('[data-nav-row]') ?? null;
}

/** Remember an element as its row's position (called whenever focus lands in a row). */
export function rememberFocus(el: HTMLElement) {
  const row = rowOf(el);
  if (row) rowMemory.set(row, el);
}

export type MoveResult = { moved: true; target: HTMLElement } | { moved: false; paged?: boolean };

function focusTarget(target: HTMLElement) {
  target.focus({ preventScroll: true });
  rememberFocus(target);
  ensureVisible(target);
}

/**
 * Move focus from `from` (default: the active element) in `dir`. Returns what happened so the
 * caller can decide whether to swallow the key.
 */
export function moveFocus(dir: Direction, from: HTMLElement | null = document.activeElement as HTMLElement | null, leavingHover = false): MoveResult {
  const root = scopeRoot();
  const pageScope = root === document.body;

  if (!from || from === document.body || from === root || !root.contains(from) || !isNavigable(from)) {
    const first = initialTarget(root);
    if (!first) return { moved: false };
    focusTarget(first);
    return { moved: true, target: first };
  }

  // Inside an expanded hover card: its buttons are a little horizontal toolbar.
  const hoverCard = from.closest<HTMLElement>('[data-hover-card]');
  if (hoverCard) {
    if (horizontal(dir)) {
      const target = pickNearest(boxOf(from, pageScope), navigableIn(hoverCard).map((item) => ({ item, box: boxOf(item, pageScope) })), dir);
      if (!target) return { moved: false };
      focusTarget(target);
      return { moved: true, target };
    }
    const origin = hoverOrigin && hoverOrigin.isConnected ? hoverOrigin : null;
    if (dir === 'up' && origin) {
      focusTarget(origin);
      return { moved: true, target: origin };
    }
    if (dir === 'down' && origin) {
      hooks.closeHover();
      return moveFocus('down', origin, true);
    }
    return { moved: false };
  }

  // A card with its hover card open: Down steps into the card's buttons.
  if (dir === 'down' && !leavingHover) {
    const card = openHoverCardOver(from);
    const first = card ? navigableIn(card)[0] : null;
    if (first) {
      hoverOrigin = from;
      first.focus({ preventScroll: true });
      return { moved: true, target: first };
    }
  }

  const fromBox = boxOf(from, pageScope);
  const row = rowOf(from);
  let pool = navigableIn(root).filter((el) => el !== from && !el.closest('[data-hover-card]'));

  if (row && horizontal(dir)) {
    const inRow = pool.filter((el) => row.contains(el));
    const target = pickNearest(fromBox, inRow.map((item) => ({ item, box: boxOf(item, pageScope) })), dir);
    if (target) {
      column = null;
      hooks.closeHover();
      focusTarget(target);
      return { moved: true, target };
    }
    const edge = new CustomEvent<EdgeEventDetail>(EDGE_EVENT, { cancelable: true, detail: { direction: dir, from } });
    row.dispatchEvent(edge);
    if (edge.defaultPrevented) hooks.closeHover();
    return { moved: false, paged: edge.defaultPrevented };
  }

  // Leaving fixed chrome downwards: go back to where you were on the page if it's still in view.
  if (dir === 'down' && pageScope && from.closest('[data-nav-fixed]')) {
    const back = lastContent && lastContent.isConnected && isNavigable(lastContent) && inViewport(lastContent) ? lastContent : null;
    if (back) {
      hooks.closeHover();
      focusTarget(back);
      return { moved: true, target: back };
    }
    const visible = pool.filter((el) => !el.closest('[data-nav-fixed]') && inViewport(el));
    const preferred = visible.find((el) => el.matches('[data-nav-autofocus]'));
    if (preferred) {
      hooks.closeHover();
      focusTarget(preferred);
      return { moved: true, target: preferred };
    }
    if (visible.length) pool = visible.concat(pool.filter((el) => el.closest('[data-nav-fixed]')));
  }

  const anchor = !horizontal(dir) && column && column.origin === from ? column.x : undefined;
  const candidates = pool.map((item) => ({ item, box: boxOf(item, pageScope) }));
  let target = pickNearest(fromBox, candidates, dir, anchor, !!row);
  if (!target) return { moved: false };

  // Entering another row: return to the card you last had there, when it's still on screen.
  const targetRow = rowOf(target);
  let x = anchor ?? cx(fromBox);
  if (!horizontal(dir) && targetRow && targetRow !== row) {
    const remembered = rowMemory.get(targetRow);
    if (remembered && remembered !== target && targetRow.contains(remembered) && isNavigable(remembered)) {
      target = remembered;
      x = cx(boxOf(remembered, pageScope));
    }
  }

  // Entering a tab list (navbar, settings sidebar) lands on the current tab.
  const tabs = target.closest<HTMLElement>('[data-nav-tabs]');
  if (tabs && !tabs.contains(from)) {
    const current = tabs.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"], [aria-selected="true"]');
    if (current && isNavigable(current)) target = current;
  }

  column = horizontal(dir) ? null : { x, origin: target };
  hooks.closeHover();
  focusTarget(target);
  return { moved: true, target };
}

let lastContent: HTMLElement | null = null;

/** Track the last focused element outside fixed chrome, for coming back down from the navbar. */
export function noteFocus(el: HTMLElement) {
  if (!el.closest('[data-nav-fixed], [data-hover-card]') && el !== document.body) lastContent = el;
  rememberFocus(el);
}

const SCROLL_MARGIN = 48;
const NAV_INSET = 68;

function scrollable(el: HTMLElement) {
  const { overflowY } = getComputedStyle(el);
  return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
}

/** Scroll just enough (vertically) to show `el`, below the fixed navbar on the page. */
export function ensureVisible(el: HTMLElement) {
  if (el.closest('[data-hover-card]')) return;
  const behavior = scrollBehavior();
  let { top, bottom } = el.getBoundingClientRect();
  for (let parent = el.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    if (!scrollable(parent)) continue;
    const box = parent.getBoundingClientRect();
    const margin = Math.min(SCROLL_MARGIN, box.height / 6);
    const delta = top < box.top + margin ? top - box.top - margin
      : bottom > box.bottom - margin ? Math.min(bottom - box.bottom + margin, top - box.top - margin) : 0;
    const previous = parent.scrollTop;
    const destination = Math.max(0, Math.min(previous + delta, parent.scrollHeight - parent.clientHeight));
    if (destination === previous) continue;
    parent.scrollTo({ top: destination, behavior });
    // Outer scrollers need the target's eventual position while the inner one animates.
    top -= destination - previous;
    bottom -= destination - previous;
  }
  if (scopeRoot() !== document.body || el.closest('[data-nav-fixed]')) return;
  // Keep a row's title in view along with its cards.
  const row = rowOf(el);
  if (row) top = Math.min(top, row.getBoundingClientRect().top);
  let delta = 0;
  if (top < NAV_INSET + 8) delta = top - NAV_INSET - SCROLL_MARGIN;
  else if (bottom > window.innerHeight - SCROLL_MARGIN) delta = Math.min(bottom - window.innerHeight + SCROLL_MARGIN, top - NAV_INSET - 8);
  // At the top of the page, show the billboard rather than stopping just under the navbar.
  if (delta && window.scrollY + delta < window.innerHeight * 0.35 && delta < 0) delta = -window.scrollY;
  if (delta) window.scrollTo({ top: window.scrollY + delta, behavior });
}

/** Should an arrow key on this element move focus, or does the element need it (text caret, sliders…)? */
export function arrowLeavesElement(el: Element | null, dir: Direction): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.closest('[role="menu"], [role="listbox"], [role="slider"], [role="grid"], [role="radiogroup"], [role="tree"]')) return false;
  if (el instanceof HTMLSelectElement) return false;
  if (el instanceof HTMLTextAreaElement) {
    if (horizontal(dir)) return false;
    const at = el.selectionStart ?? 0;
    return dir === 'up' ? at === 0 : at === el.value.length;
  }
  if (el instanceof HTMLInputElement) {
    const type = el.type;
    if (['range', 'number', 'radio', 'date', 'time', 'datetime-local', 'month', 'week', 'color'].includes(type)) return false;
    if (['checkbox', 'button', 'submit', 'reset', 'file', 'image'].includes(type)) return true;
    if (!horizontal(dir)) return true;
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      return true;
    }
    if (start == null || end == null) return true;
    return dir === 'left' ? start === 0 && end === 0 : start === el.value.length && end === el.value.length;
  }
  if (el.isContentEditable) return false;
  return true;
}

/** Elements that a synthetic (gamepad) Enter should click. */
export function isActivatable(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement
    && el.matches('button, a[href], summary, input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], [role="button"], [role="switch"], [role="tab"], [role="option"], [role="menuitem"], [role="checkbox"], [role="link"]');
}
