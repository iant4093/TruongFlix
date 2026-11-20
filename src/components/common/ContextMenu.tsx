import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import {
  ArrowLeft,
  Check,
  ClipboardPaste,
  Copy,
  FolderOpen,
  Info,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Settings,
  TextSelect,
  Wrench,
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { playItem } from '../../services/player';
import { revealInFileManager } from '../../services/files';
import { runScan } from '../../services/scanner';
import { playTargetFor } from '../../store/selectors';
import type { MediaItem } from '../../types/media';

export type ContextItem =
  | { label: string; icon?: ReactNode; onSelect: () => void | Promise<unknown>; disabled?: boolean; danger?: boolean }
  | 'divider';

interface MenuState {
  x: number;
  y: number;
  items: ContextItem[];
  title?: string;
}

const useMenu = create<{ menu: MenuState | null }>(() => ({ menu: null }));

/** Opens TruongFlix's menu at the pointer instead of the system one. */
export function openContextMenu(event: { clientX: number; clientY: number; preventDefault: () => void }, items: ContextItem[], title?: string) {
  event.preventDefault();
  const list = items.filter((item, i, all) => item !== 'divider' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'divider'));
  if (!list.length) return useMenu.setState({ menu: null });
  useMenu.setState({ menu: { x: event.clientX, y: event.clientY, items: list, title } });
}

export function closeContextMenu() {
  if (useMenu.getState().menu) useMenu.setState({ menu: null });
}

const ICON = 'h-4 w-4 shrink-0';

/** Library titles: play, details, My List, fix match, show the file. */
function titleItems(item: MediaItem): ContextItem[] {
  const s = useLibraryStore.getState();
  const target = playTargetFor(item, s.episodesBySeries);
  return [
    { label: 'Play', icon: <Play className={`${ICON} fill-current`} strokeWidth={0} />, onSelect: () => playItem(item), disabled: !target },
    { label: 'More info', icon: <Info className={ICON} />, onSelect: () => s.openDetail(item.key) },
    'divider',
    {
      label: item.myList ? 'Remove from My List' : 'Add to My List',
      icon: item.myList ? <Check className={ICON} /> : <Plus className={ICON} />,
      onSelect: () => s.toggleMyList(item),
    },
    // Fix match and opening the media folder are for unrestricted profiles, as in the details page.
    ...(s.activeProfile?.maturity === 'all' ? ([{ label: 'Fix match', icon: <Wrench className={ICON} />, onSelect: () => s.openFixMatch(item.key) }] as ContextItem[]) : []),
    ...(target?.filePath && s.activeProfile?.maturity === 'all'
      ? ([{ label: navigator.userAgent.includes('Mac') ? 'Show in Finder' : 'Show in File Explorer', icon: <FolderOpen className={ICON} />, onSelect: () => revealInFileManager(target.filePath) }] as ContextItem[])
      : []),
  ];
}

const isEditable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement =>
  !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(el.type)) || (el as HTMLElement).isContentEditable);

/** Cut, copy, paste and select all for text fields. */
function editItems(field: HTMLElement): ContextItem[] {
  const input = field as HTMLInputElement;
  const hasSelection = typeof input.selectionStart === 'number' ? input.selectionStart !== input.selectionEnd : !!window.getSelection()?.toString();
  const readOnly = input.readOnly || input.disabled;
  const exec = (cmd: string) => () => {
    field.focus();
    document.execCommand(cmd);
  };
  return [
    { label: 'Cut', icon: <Scissors className={ICON} />, onSelect: exec('cut'), disabled: !hasSelection || readOnly },
    { label: 'Copy', icon: <Copy className={ICON} />, onSelect: exec('copy'), disabled: !hasSelection },
    {
      label: 'Paste',
      icon: <ClipboardPaste className={ICON} />,
      disabled: readOnly,
      onSelect: async () => {
        field.focus();
        try {
          const text = await navigator.clipboard.readText();
          if (text) document.execCommand('insertText', false, text);
        } catch {
          useLibraryStore.getState().toast(`Press ${navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+'}V to paste`, 'info');
        }
      },
    },
    'divider',
    { label: 'Select all', icon: <TextSelect className={ICON} />, onSelect: exec('selectAll') },
  ];
}

/** Anywhere else: go back, search, scan and settings. */
function appItems(): ContextItem[] {
  const s = useLibraryStore.getState();
  const open = !!(s.detailKey || s.fixMatchKey || s.actor || s.settingsOpen || s.overlay || s.addTorrentModal?.open);
  const searchable = s.view !== 'browse' && s.view !== 'games' && s.view !== 'music' && s.view !== 'live';
  return [
    ...(open
      ? ([{ label: 'Back', icon: <ArrowLeft className={ICON} />, onSelect: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })) }, 'divider'] as ContextItem[])
      : []),
    {
      label: 'Search',
      icon: <Search className={ICON} />,
      onSelect: () => {
        const input = document.querySelector<HTMLInputElement>('header input[aria-label^="Search"], main input[aria-label^="Search"]');
        if (input) input.focus();
        else if (searchable) document.querySelector<HTMLButtonElement>('header button[aria-label="Search"]')?.click();
      },
    },
    { label: s.scan.running ? 'Scanning…' : 'Scan library', icon: <RefreshCw className={ICON} />, onSelect: () => runScan(), disabled: s.scan.running },
    { label: 'Settings', icon: <Settings className={ICON} />, onSelect: () => s.setSettingsOpen(true) },
  ];
}

/**
 * Replaces the web view's system menu (Back/Reload/Inspect) with TruongFlix's own: title actions
 * on library cards, editing in text fields, Copy for selected text, and app shortcuts elsewhere.
 * Parts of the app with their own menu (songs) open it and stop the event first. Shift+right-click
 * still shows the system menu.
 */
export function initContextMenu(): () => void {
  const onMenu = (event: MouseEvent) => {
    if (event.defaultPrevented || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    // The players and web frames draw their own surfaces.
    if (document.documentElement.classList.contains('player-mode')) return void event.preventDefault();
    const field = target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') ?? null;
    if (field && isEditable(field)) return openContextMenu(event, editItems(field as HTMLElement));
    const selected = window.getSelection()?.toString() ?? '';
    if (selected.trim()) {
      return openContextMenu(event, [{ label: 'Copy', icon: <Copy className={ICON} />, onSelect: () => navigator.clipboard.writeText(selected).catch(() => document.execCommand('copy')) }]);
    }
    const key = target?.closest<HTMLElement>('[data-item-key]')?.dataset.itemKey;
    const item = key ? useLibraryStore.getState().items.find((i) => i.key === key) : null;
    if (item) {
      useLibraryStore.getState().setHover(null);
      return openContextMenu(event, titleItems(item), item.title);
    }
    openContextMenu(event, appItems());
  };
  window.addEventListener('contextmenu', onMenu);
  return () => window.removeEventListener('contextmenu', onMenu);
}

/** The menu itself; rendered once at the app root. */
export default function ContextMenu() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    setActive(-1);
    if (!menu || !ref.current) return setPos(null);
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    const left = menu.x + w + 8 > window.innerWidth ? Math.max(8, menu.x - w) : menu.x;
    const top = menu.y + h + 8 > window.innerHeight ? Math.max(8, menu.y - h) : menu.y;
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => closeContextMenu();
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      const enabled = menu.items.map((it, i) => (it !== 'divider' && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setActive((a) => {
          const at = enabled.indexOf(a);
          const next = e.key === 'ArrowDown' ? enabled[(at + 1) % enabled.length] : enabled[(at - 1 + enabled.length) % enabled.length];
          return next ?? -1;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        ref.current?.querySelector<HTMLButtonElement>('[data-active="true"]')?.click();
      }
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
    };
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={menu.title ?? 'Menu'}
      onContextMenu={(e) => e.preventDefault()}
      className="nf-menu-enter fixed z-[400] min-w-[13rem] max-w-[18rem] overflow-hidden rounded-md border border-white/10 bg-nf-menu/95 py-1 text-sm text-white shadow-modal backdrop-blur-md"
      style={pos ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}
    >
      {menu.title && <div className="truncate px-3 pb-1.5 pt-1 text-xs font-semibold text-nf-muted">{menu.title}</div>}
      {menu.items.map((item, i) =>
        item === 'divider' ? (
          <div key={i} className="my-1 border-t border-white/10" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-active={active === i || undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              closeContextMenu();
              void Promise.resolve()
                .then(item.onSelect)
                .catch((e) => useLibraryStore.getState().toast(String(e instanceof Error ? e.message : e), 'error'));
            }}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors disabled:cursor-default disabled:opacity-40 ${
              active === i && !item.disabled ? 'bg-white/10' : ''
            } ${item.danger ? 'text-[#ff6b6b]' : ''}`}
          >
            {item.icon ?? <span className="h-4 w-4" />}
            <span className="truncate">{item.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
