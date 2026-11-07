import { useLayoutEffect, useRef, type MouseEvent, type RefObject } from 'react';

type DialogOptions = {
  onClose: () => void;
  onEscape?: () => void;
  active?: boolean;
  priority?: number;
  initialFocus?: RefObject<HTMLElement>;
  focusKey?: unknown;
};

type DialogLayer = {
  root: HTMLElement;
  priority: number;
  close: () => void;
  focus: () => void;
  restore: HTMLElement[];
};

const layers: DialogLayer[] = [];
const focusable = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

function topLayer(visibleOnly = false) {
  return layers.reduce<DialogLayer | undefined>(
    (top, layer) => (!top || layer.priority >= top.priority) && (!visibleOnly || isVisible(layer.root)) ? layer : top,
    undefined,
  );
}

/** Root of the top visible dialog layer (spatial navigation stays inside it), or null. */
export function topDialogRoot(): HTMLElement | null {
  return topLayer(true)?.root ?? null;
}

function ownsFocus(root: HTMLElement, target: Element) {
  if (root.contains(target)) return true;
  // Dropdowns and action menus are portalled to body and keep their owner via aria-controls.
  return [...root.querySelectorAll('[aria-expanded="true"][aria-controls]')].some((control) => {
    const ids = control.getAttribute('aria-controls')?.split(/\s+/) ?? [];
    return ids.some((id) => document.getElementById(id)?.contains(target));
  });
}

function isVisible(element: HTMLElement) {
  if (!element.isConnected || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const { display, visibility } = getComputedStyle(ancestor);
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return false;
  }
  return true;
}

function handleKey(event: KeyboardEvent) {
  if (event.defaultPrevented || (event.key !== 'Escape' && event.key !== 'Tab')) return;
  const top = topLayer(true);
  if (!top) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    top.close();
    return;
  }
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;

  const items = [...top.root.querySelectorAll<HTMLElement>(focusable)]
    .filter((element) => element.tabIndex >= 0 && isVisible(element))
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = index === -1
    ? (event.shiftKey ? items.at(-1) : items[0])
    : items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length];
  event.preventDefault();
  if (next) next.focus();
  else top.focus();
}

function handleFocus(event: FocusEvent) {
  const top = topLayer(true);
  if (top && event.target instanceof Element && !ownsFocus(top.root, event.target)) top.focus();
}

/** One keyboard and focus boundary for each visible dialog, ordered by its overlay z-index. */
export function useModalDialog(
  ref: RefObject<HTMLElement>,
  { onClose, onEscape = onClose, active = true, priority = 0, initialFocus, focusKey }: DialogOptions,
) {
  const options = useRef({ onEscape, initialFocus });
  options.current = { onEscape, initialFocus };

  useLayoutEffect(() => {
    const root = ref.current;
    if (!active || !root) return;

    const previous = topLayer();
    const opener = document.activeElement;
    const layer: DialogLayer = {
      root,
      priority,
      close: () => options.current.onEscape(),
      focus: () => {
        const first = options.current.initialFocus?.current;
        (first && isVisible(first) ? first : root).focus({ preventScroll: true });
      },
      restore: [...(opener instanceof HTMLElement ? [opener] : []), ...(previous?.restore ?? [])],
    };

    if (!layers.length) {
      document.documentElement.classList.add('nf-modal-open');
      // Portalled menus handle their own Escape first, in the capture phase.
      document.addEventListener('keydown', handleKey);
      document.addEventListener('focusin', handleFocus);
    }
    layers.push(layer);
    if (topLayer(true) === layer) layer.focus();

    return () => {
      const wasTop = topLayer() === layer;
      layers.splice(layers.indexOf(layer), 1);
      if (!layers.length) {
        document.documentElement.classList.remove('nf-modal-open');
        document.removeEventListener('keydown', handleKey);
        document.removeEventListener('focusin', handleFocus);
      }
      if (!wasTop) return;

      const next = topLayer(true);
      const target = layer.restore.find((element) => isVisible(element) && !root.contains(element)
        && (!next || ownsFocus(next.root, element)));
      if (target) target.focus({ preventScroll: true });
      else next?.focus();
      // React can restore the old focused node at the end of the same commit.
      if (target) queueMicrotask(() => {
        const focused = document.activeElement;
        if (topLayer(true) === next && isVisible(target) && (focused === document.body || (focused && root.contains(focused)))) {
          target.focus({ preventScroll: true });
        }
      });
    };
  }, [active, priority, ref]);

  useLayoutEffect(() => {
    const top = topLayer(true);
    if (active && focusKey !== undefined && top?.root === ref.current) top.focus();
  }, [active, focusKey, ref]);

  return {
    onBackdropMouseDown(event: MouseEvent<HTMLElement>) {
      if (event.button === 0 && event.target === event.currentTarget && topLayer(true)?.root === ref.current) {
        event.preventDefault();
        onClose();
      }
    },
  };
}
