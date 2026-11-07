import { useId, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { motion, useIsPresent } from 'framer-motion';
import { X } from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog';
import IconButton from './IconButton';
import { backdrop, dialogPanel } from '../../lib/motion';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'window';

const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-3xl',
  xl: 'max-w-4xl',
  // App-window-sized panels such as Settings.
  window: 'max-w-[1060px]',
};

type BackdropEvents = Pick<HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDrop'> & { [data: `data-${string}`]: string | boolean };

interface DialogProps {
  onClose: () => void;
  /** Escape can do something gentler than closing (e.g. step back a page). */
  onEscape?: () => void;
  /** Visible heading. Without one, pass `label` for the accessible name. */
  title?: ReactNode;
  label?: string;
  description?: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Overlay z-index and keyboard/focus priority for stacked dialogs. */
  priority: number;
  size?: DialogSize;
  /** `center` keeps the panel in view and scrolls the body; `top` scrolls the whole page of the dialog. */
  align?: 'center' | 'top';
  /** Rendered at all? Dialogs inside AnimatePresence can leave this on and just unmount. */
  open?: boolean;
  /** Takes keyboard focus (e.g. off while a child dialog is on top). */
  active?: boolean;
  role?: 'dialog' | 'alertdialog';
  initialFocus?: RefObject<HTMLElement>;
  focusKey?: unknown;
  describedBy?: string;
  /** Id of a heading rendered inside custom content. */
  labelledBy?: string;
  /** `header` = title row with close button; `floating` = a sticky close button over custom content; `none` = no chrome. */
  chrome?: 'header' | 'floating' | 'none';
  /** Hairline under the header (useful with a scrolling body). */
  divided?: boolean;
  closeLabel?: string;
  closeDisabled?: boolean;
  className?: string;
  bodyClassName?: string;
  backdropProps?: BackdropEvents;
  panelRef?: RefObject<HTMLDivElement>;
  /** The scrolling backdrop in `top` alignment (e.g. to reset scroll). */
  backdropRef?: RefObject<HTMLDivElement>;
}

/** The one modal frame: dim backdrop, rounded surface, title row, body and footer. */
export default function Dialog({
  onClose,
  onEscape,
  title,
  label,
  description,
  icon,
  footer,
  children,
  priority,
  size = 'md',
  align = 'center',
  open = true,
  active = true,
  role = 'dialog',
  initialFocus,
  focusKey,
  describedBy,
  labelledBy,
  chrome = 'header',
  divided = false,
  closeLabel = 'Close',
  closeDisabled,
  className = '',
  bodyClassName,
  backdropProps,
  panelRef,
  backdropRef,
}: DialogProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? ownRef;
  const titleId = useId();
  const present = useIsPresent();
  const { onBackdropMouseDown } = useModalDialog(ref, {
    onClose,
    onEscape,
    active: open && active && present,
    priority,
    initialFocus,
    focusKey,
  });
  if (!open) return null;

  const labelled = chrome === 'header' && title != null;
  const centered = align === 'center';
  const close = (
    <IconButton onClick={onClose} disabled={closeDisabled} aria-label={closeLabel} variant={chrome === 'floating' ? 'surface' : 'ghost'}>
      <X className="h-5 w-5" />
    </IconButton>
  );

  return (
    <motion.div
      ref={backdropRef}
      variants={backdrop}
      initial="initial"
      animate="animate"
      exit="exit"
      onMouseDown={onBackdropMouseDown}
      style={{ zIndex: priority }}
      className={`fixed inset-0 bg-black/75 backdrop-blur-xs ${
        centered ? 'flex items-center justify-center p-6' : 'overflow-y-auto overscroll-contain px-4 pb-10 pt-8'
      } ${present ? '' : 'pointer-events-none'}`}
      {...backdropProps}
    >
      <motion.div
        ref={ref}
        role={role}
        tabIndex={-1}
        aria-modal="true"
        aria-hidden={!present || undefined}
        aria-labelledby={labelledBy ?? (labelled ? titleId : undefined)}
        aria-label={labelled || labelledBy ? undefined : label}
        aria-describedby={describedBy}
        variants={dialogPanel}
        initial="initial"
        animate="animate"
        exit="exit"
        className={`relative w-full ${SIZES[size]} rounded-xl bg-nf-surface shadow-2xl outline-none ring-1 ring-white/10 ${
          centered ? 'flex max-h-[90vh] flex-col overflow-hidden' : 'mx-auto h-max'
        } ${className}`}
      >
        {chrome === 'floating' && (
          <div className="pointer-events-none sticky top-0 z-20 flex h-0 items-start justify-end">
            <div className="pointer-events-auto mr-4 mt-4">{close}</div>
          </div>
        )}
        {chrome === 'header' && (
          <div className={`flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-5 ${divided ? 'border-b border-white/10' : ''}`}>
            <div className="flex min-w-0 items-center gap-3">
              {icon}
              <div className="min-w-0">
                {title != null && <h2 id={titleId} className="text-xl font-bold leading-snug">{title}</h2>}
                {description != null && <div className="mt-0.5 text-sm text-nf-secondary">{description}</div>}
              </div>
            </div>
            <div className="-mr-2 -mt-1">{close}</div>
          </div>
        )}
        <div className={bodyClassName ?? `${chrome === 'header' ? 'px-6 pb-6' : ''} ${divided ? 'pt-5' : ''} ${centered ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>
          {children}
        </div>
        {footer != null && (
          <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-white/10 bg-black/30 px-6 py-4">{footer}</div>
        )}
      </motion.div>
    </motion.div>
  );
}

/** Round icon tile shown beside a dialog title. */
export function DialogIcon({ children, tone = 'red' }: { children: ReactNode; tone?: 'red' | 'neutral' }) {
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
        tone === 'red' ? 'bg-nf-red/15 text-nf-red' : 'bg-white/10 text-white'
      }`}
    >
      {children}
    </span>
  );
}

interface OverlayProps {
  onClose: () => void;
  label: string;
  priority: number;
  children: ReactNode;
  className?: string;
  panelRef?: RefObject<HTMLDivElement>;
  initialFocus?: RefObject<HTMLElement>;
  active?: boolean;
}

/** Full-page takeover (history, health, wrapped): opaque page background, scrolls as a whole. */
export function FullScreenOverlay({ onClose, label, priority, children, className = 'bg-nf-bg', panelRef, initialFocus, active = true }: OverlayProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? ownRef;
  const present = useIsPresent();
  useModalDialog(ref, { onClose, active: active && present, priority, initialFocus });
  return (
    <motion.div
      variants={backdrop}
      initial="initial"
      animate="animate"
      exit="exit"
      ref={ref}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-hidden={!present || undefined}
      aria-label={label}
      style={{ zIndex: priority }}
      className={`fixed inset-0 overflow-y-auto outline-none ${className} ${present ? '' : 'pointer-events-none'}`}
    >
      {children}
    </motion.div>
  );
}

/** Large round close button for full-screen overlays. */
export function OverlayCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <IconButton onClick={onClose} aria-label="Close" variant="filled" size="lg">
      <X className="h-5 w-5" />
    </IconButton>
  );
}
