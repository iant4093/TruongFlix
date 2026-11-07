import type { ReactNode } from 'react';
import Dialog from '../common/Dialog';

export default function Modal({
  title,
  onClose,
  children,
  active = true,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  active?: boolean;
  wide?: boolean;
}) {
  return (
    <Dialog title={title} onClose={onClose} open={active} priority={100} size={wide ? 'lg' : 'md'}>
      {children}
    </Dialog>
  );
}
