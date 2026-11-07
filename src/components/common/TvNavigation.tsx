import { useEffect } from 'react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { topDialogRoot } from '../../hooks/useModalDialog';
import { closeCardHoverCards } from './HoverCard';
import { isTvActive, useTvMode } from '../../lib/tvMode';
import { startGamepadLoop, type PadAction } from '../../lib/gamepad';
import {
  arrowLeavesElement,
  configureSpatialNav,
  initialTarget,
  isActivatable,
  isNavigable,
  moveFocus,
  navigableIn,
  noteFocus,
  scopeRoot,
  type Direction,
} from '../../lib/spatialNav';

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const CODES: Record<string, string> = { ' ': 'Space', a: 'KeyA', Enter: 'Enter', Escape: 'Escape' };
const CURSOR_IDLE_MS = 3000;

const root = () => document.documentElement;
const playerOpen = () => {
  const s = useLibraryStore.getState();
  return !!s.playerSession && !s.playerMini;
};

/** Keydown as if from a keyboard, so every existing shortcut and dialog handles controller input too. */
export function sendKey(key: string, target: EventTarget = document.activeElement ?? document.body) {
  const event = new KeyboardEvent('keydown', { key, code: CODES[key] ?? key, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  target.dispatchEvent(new KeyboardEvent('keyup', { key, code: CODES[key] ?? key, bubbles: true, cancelable: true, composed: true }));
  return event.defaultPrevented;
}

function engageAuto() {
  if (!useTvMode.getState().engaged) useTvMode.setState({ engaged: true });
}

let lastFocused: HTMLElement | null = null;
let hoverOrigin: HTMLElement | null = null;

function closeHovers() {
  closeCardHoverCards();
  if (useLibraryStore.getState().hover) useLibraryStore.getState().setHover(null);
}

/** Put focus back somewhere sensible after the focused element disappeared. */
function restoreFocus() {
  const active = document.activeElement;
  if (playerOpen() || (active && active !== document.body && active !== document.documentElement)) return;
  const scope = scopeRoot();
  const candidates = [hoverOrigin, lastFocused].filter((el): el is HTMLElement => !!el && scope.contains(el) && isNavigable(el));
  const target = candidates[0] ?? initialTarget(scope);
  target?.focus({ preventScroll: true });
}

/** Back with nothing left to close: up to the navbar, then Home. */
function goBack() {
  if (playerOpen() || topDialogRoot()) return;
  if (document.querySelector('[data-hover-card]')) {
    closeHovers();
    return;
  }
  const active = document.activeElement;
  const nav = document.querySelector<HTMLElement>('[data-nav-tabs]');
  if (!nav) return;
  if (!(active instanceof HTMLElement) || !active.closest('[data-nav-fixed]')) {
    const current = nav.querySelector<HTMLElement>('[aria-current="page"]') ?? navigableIn(nav)[0];
    current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const s = useLibraryStore.getState();
  if (s.view !== 'home' || s.search) {
    s.setView('home');
    nav.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }
}

/** LB/RB: the open dialog's tabs (e.g. the Settings sidebar), else the navbar sections. */
function cycleTabs(step: 1 | -1) {
  const scope = topDialogRoot();
  const container = scope ? scope.querySelector<HTMLElement>('[data-nav-tabs]') : document.querySelector<HTMLElement>('header [data-nav-tabs]');
  if (!container) return;
  const items = navigableIn(container);
  if (!items.length) return;
  const current = items.findIndex((el) => el.matches('[aria-current="page"], [aria-current="true"], [aria-selected="true"], [aria-pressed="true"]'));
  const next = items[(current + step + items.length) % items.length];
  next.click();
  next.focus({ preventScroll: true });
}

const MY_LIST = /my list|save to browse|saved in browse/i;

/** X: add/remove the focused title from My List (or the screen's secondary action). */
function secondaryAction() {
  const active = document.activeElement as HTMLElement | null;
  const card = active?.closest<HTMLElement>('[data-item-key]');
  const s = useLibraryStore.getState();
  if (card) {
    const item = s.items.find((i) => i.key === card.dataset.itemKey);
    if (item) {
      void s.toggleMyList(item);
      return;
    }
  }
  const hover = document.querySelector<HTMLElement>('[data-hover-card]');
  const scope = scopeRoot();
  const pools = [hover, scope].filter((el): el is HTMLElement => !!el);
  for (const pool of pools) {
    const button = pool.querySelector<HTMLElement>('[data-tv-secondary]')
      ?? navigableIn(pool).find((el) => MY_LIST.test(el.getAttribute('aria-label') ?? el.textContent ?? ''));
    if (button && isNavigable(button)) {
      button.click();
      return;
    }
  }
}

/** Y: the current screen's search field. */
function focusSearch() {
  const scope = topDialogRoot();
  if (scope) {
    navigableIn(scope).find((el) => el instanceof HTMLInputElement && (el.type === 'search' || /search/i.test(el.getAttribute('aria-label') ?? el.placeholder)))?.focus();
    return;
  }
  const field = document.querySelector<HTMLInputElement>('#library-search input');
  if (field) {
    field.focus();
    return;
  }
  document.querySelector<HTMLElement>('header button[aria-label^="Search"]')?.click();
}

/** In the player the D-pad and buttons are transport controls, sent to the page so a focused button never eats them. */
function handlePlayerPad(action: PadAction) {
  const body = document.body;
  switch (action) {
    case 'left': case 'seekBack': sendKey('ArrowLeft', body); break;
    case 'right': case 'seekForward': sendKey('ArrowRight', body); break;
    case 'up': sendKey('ArrowUp', body); break;
    case 'down': sendKey('ArrowDown', body); break;
    case 'accept':
      sendKey(useLibraryStore.getState().playerPrompt ? 'Enter' : ' ', body);
      break;
    case 'start': sendKey(' ', body); break;
    case 'back': case 'select': sendKey('Escape', body); break;
    case 'secondary': sendKey('a', body); break;
    default: break;
  }
}

function handlePad(action: PadAction) {
  useTvMode.setState({ keyboard: true, controller: true });
  engageAuto();
  if (playerOpen()) {
    handlePlayerPad(action);
    return;
  }
  switch (action) {
    case 'up': sendKey('ArrowUp'); break;
    case 'down': sendKey('ArrowDown'); break;
    case 'left': sendKey('ArrowLeft'); break;
    case 'right': sendKey('ArrowRight'); break;
    case 'accept': case 'start': sendKey('Enter'); break;
    case 'back': case 'select': sendKey('Escape'); break;
    case 'secondary': secondaryAction(); break;
    case 'search': focusSearch(); break;
    case 'prevTab': cycleTabs(-1); break;
    case 'nextTab': cycleTabs(1); break;
    default: break;
  }
}

function applyClasses() {
  const s = useTvMode.getState();
  const enabled = s.setting !== 'off';
  root().classList.toggle('tv-mode', isTvActive(s));
  root().classList.toggle('tv-focus', enabled && s.keyboard);
}

/**
 * TV mode: arrow-key / remote / controller navigation, the focus ring, the larger layout and
 * cursor hiding. Mounted once at the app root.
 */
export default function TvNavigation() {
  const setting = useLibraryStore((s) => s.settings.tv_mode);

  useEffect(() => {
    useTvMode.setState({ setting, ...(setting === 'off' ? { keyboard: false, engaged: false } : {}) });
  }, [setting]);

  useEffect(() => {
    applyClasses();
    const unsubscribe = useTvMode.subscribe(applyClasses);
    configureSpatialNav({ scope: topDialogRoot, closeHover: closeHovers });
    return () => {
      unsubscribe();
      root().classList.remove('tv-mode', 'tv-focus', 'tv-cursor-hidden');
    };
  }, []);

  // Keyboard: arrows move focus, synthetic Enter clicks, Backspace = Back, Escape falls back to the navbar/Home.
  useEffect(() => {
    if (setting === 'off') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const dir = ARROWS[e.key];
      if (dir) {
        if (e.defaultPrevented || playerOpen() || !arrowLeavesElement(document.activeElement, dir)) return;
        if (!useTvMode.getState().keyboard) useTvMode.setState({ keyboard: true });
        const current = document.activeElement;
        if ((!current || current === document.body) && lastFocused && scopeRoot().contains(lastFocused) && isNavigable(lastFocused)) {
          // Nothing focused (e.g. back from the player): pick up where you were.
          e.preventDefault();
          lastFocused.focus({ preventScroll: true });
          return;
        }
        const result = moveFocus(dir);
        if (result.moved || ('paged' in result && result.paged)) {
          e.preventDefault();
          engageAuto();
          hideCursor();
        }
        return;
      }
      if (e.key === 'Enter' && !e.isTrusted && !e.defaultPrevented && isActivatable(target)) {
        e.preventDefault();
        target.click();
        return;
      }
      if (e.key === 'Backspace' && !e.defaultPrevented && !target?.closest('input, textarea, select, [contenteditable="true"]')) {
        e.preventDefault();
        sendKey('Escape');
        return;
      }
      if (e.key === 'Escape') {
        // Let the dialogs and the app's own Escape handling run first.
        window.setTimeout(() => {
          if (!e.defaultPrevented) goBack();
        }, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setting]);

  // Focus bookkeeping: remember rows/positions, land inside newly opened dialogs, recover lost focus.
  useEffect(() => {
    if (setting === 'off') return;
    let restoreTimer = 0;
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (el.closest('[data-hover-card]')) {
        const prev = e.relatedTarget;
        if (prev instanceof HTMLElement && !prev.closest('[data-hover-card]')) hoverOrigin = prev;
      } else {
        hoverOrigin = null;
        if (isNavigable(el)) lastFocused = el;
      }
      noteFocus(el);
      // A dialog focuses its own panel; in TV mode put the ring on its first control instead.
      if (useTvMode.getState().keyboard && el.getAttribute('role')?.match(/dialog/) && el.tabIndex === -1) {
        requestAnimationFrame(() => {
          if (document.activeElement === el) initialTarget(el)?.focus({ preventScroll: true });
        });
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget || !useTvMode.getState().keyboard) return;
      window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(restoreFocus, 60);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(restoreTimer);
    };
  }, [setting]);

  // Mouse: moving it shows the cursor and the normal hover behaviour again.
  useEffect(() => {
    if (setting === 'off') return;
    let last: { x: number; y: number } | null = null;
    let idle = 0;
    const scheduleHide = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(hideCursor, CURSOR_IDLE_MS);
    };
    const onMove = (e: MouseEvent) => {
      const moved = !last || Math.abs(e.screenX - last.x) + Math.abs(e.screenY - last.y) > 3;
      last = { x: e.screenX, y: e.screenY };
      if (!moved) return;
      root().classList.remove('tv-cursor-hidden');
      if (useTvMode.getState().keyboard) useTvMode.setState({ keyboard: false });
      if (isTvActive(useTvMode.getState())) scheduleHide();
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      root().classList.remove('tv-cursor-hidden');
      const s = useTvMode.getState();
      useTvMode.setState({ keyboard: false, ...(s.setting === 'auto' && !s.controller ? { engaged: false } : {}) });
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true, capture: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.clearTimeout(idle);
      root().classList.remove('tv-cursor-hidden');
    };
  }, [setting]);

  // Game controllers.
  useEffect(() => {
    if (setting === 'off') return;
    return startGamepadLoop({
      onAction: handlePad,
      onConnect: () => {
        useTvMode.setState({ controller: true });
        engageAuto();
        if (!controllerAnnounced) {
          controllerAnnounced = true;
          useLibraryStore.getState().toast('Controller connected — TV mode on', 'info');
        }
      },
      onDisconnect: () => useTvMode.setState({ controller: false }),
    });
  }, [setting]);

  return null;
}

let controllerAnnounced = false;

function hideCursor() {
  if (isTvActive(useTvMode.getState())) root().classList.add('tv-cursor-hidden');
}
