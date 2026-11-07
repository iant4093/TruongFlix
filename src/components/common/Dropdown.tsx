import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface DropdownOption<T extends string | number> {
  value: T;
  label: string;
  /** Muted secondary text shown in the menu (e.g. "10 Episodes"). */
  hint?: string;
}

interface Props<T extends string | number> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  size?: 'md' | 'lg';
  align?: 'left' | 'right';
  className?: string;
  ariaLabel?: string;
}

const MENU_MAX_HEIGHT = 300;
const GAP = 4;

/**
 * App-styled replacement for <select>. The menu is portalled to <body> with fixed positioning
 * so it is never clipped by modals or scroll containers, and flips upward near the screen edge.
 */
export default function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  align = 'left',
  className = '',
  ariaLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number; up: boolean } | null>(null);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  const close = useCallback(() => setOpen(false), []);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, options.some((o) => o.hint) ? 280 : 180), window.innerWidth - 16);
    const menuH = Math.min(MENU_MAX_HEIGHT, options.reduce((h, o) => h + (o.hint ? 56 : 38), 8));
    const below = Math.max(0, window.innerHeight - r.bottom - GAP - 8);
    const above = Math.max(0, r.top - GAP - 8);
    const up = below < menuH && above > below;
    const left = align === 'right' ? r.right - width : r.left;
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      width,
      maxHeight: Math.min(MENU_MAX_HEIGHT, up ? above : below),
      up,
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [align, options]);

  const openMenu = () => {
    if (!options.length) return;
    place();
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const choose = (v: T) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Close on outside click, scroll (outside the menu) or resize.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close();
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  // Keyboard navigation. Captured on window so Escape closes the menu, not the surrounding modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Left/Right are swallowed so TV-mode navigation can't leave an open menu sideways.
      const handled = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Home', 'End', 'Tab'].includes(e.key);
      if (!handled) return;
      if (e.key !== 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      if (e.key === 'ArrowDown') setActive((i) => Math.min(options.length - 1, i + 1));
      else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
      else if (e.key === 'Home') setActive(0);
      else if (e.key === 'End') setActive(options.length - 1);
      else if (e.key === 'Enter' && options[active]) choose(options[active].value);
      else if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const option = menu?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!menu || !option) return;
    // Scroll only the menu. scrollIntoView can also move a modal/the page and close the menu.
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }, [open, active]);

  const height = size === 'lg' ? 'h-11 px-4 text-lg' : 'h-10 px-3 text-sm';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-${active}` : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          // In TV mode Up/Down move between controls; Enter/A opens the menu.
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !document.documentElement.classList.contains('tv-focus')) {
            e.preventDefault();
            openMenu();
          }
        }}
        className={`inline-flex shrink-0 items-center justify-between gap-3 rounded border font-semibold text-white outline-none transition-colors focus-visible:border-white ${
          open ? 'border-white/70 bg-nf-raised' : 'border-nf-track bg-nf-menu hover:bg-nf-raised'
        } ${height} ${className}`}
      >
        <span className="truncate">{current?.label ?? 'Select…'}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-white/70 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {createPortal(
        open && pos ? (
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: 'fixed',
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
              transformOrigin: pos.up ? 'bottom' : 'top',
            }}
            className="nf-menu-enter z-[250] overflow-y-auto overscroll-contain rounded-md border border-nf-track bg-nf-menu/[0.98] py-1 shadow-[0_10px_30px_rgba(0,0,0,0.6)] backdrop-blur"
          >
            {options.map((o, i) => {
              const selected = o.value === value;
              return (
                <div
                  key={String(o.value)}
                  id={`${menuId}-${i}`}
                  role="option"
                  aria-label={o.hint ? `${o.label}, ${o.hint}` : o.label}
                  aria-selected={selected}
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                  className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm ${
                    i === active ? 'bg-white/10' : ''
                  } ${selected ? 'font-semibold text-white' : 'text-nf-soft'}`}
                >
                  <Check className={`h-4 w-4 shrink-0 ${selected ? 'text-white' : 'text-transparent'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words">{o.label}</span>
                    {o.hint && <span className="block truncate text-xs font-normal text-nf-muted" title={o.hint}>{o.hint}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null,
        document.body,
      )}
    </>
  );
}
