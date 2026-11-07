import type { ReactNode } from 'react';
import Dialog from '../common/Dialog';

export default function CatalogDialog({ title, onClose, active, children }: {
  title: string; onClose: () => void; active: boolean; children: ReactNode;
}) {
  return (
    <Dialog
      label={title}
      onClose={onClose}
      open={active}
      priority={100}
      size="xl"
      align="top"
      chrome="floating"
      backdropProps={{ 'data-catalog-scroll': true }}
    >
      {children}
    </Dialog>
  );
}
