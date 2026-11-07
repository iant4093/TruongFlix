import { useRef } from 'react';
import { X } from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog';

export default function Modal({
  title,
  onClose,
  children,
  active = true,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  active?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, active, priority: 100 });
  if (!active) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[85vh] w-full ${wide ? 'max-w-3xl' : 'max-w-2xl'} overflow-y-auto rounded-lg border border-white/10 bg-[#181818] p-6 shadow-2xl outline-none`}
      >
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="text-xl font-bold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-full bg-white/10 p-2 hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
