import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DialogOverlay, DialogTitle } from './dialog';

export function Sheet({ open, onOpenChange, title, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode;
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}><DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content aria-describedby={undefined}
      className="library-sheet fixed inset-y-0 right-0 z-50 flex w-[min(28rem,100vw)] flex-col border-l border-border bg-card p-5 outline-none">
      <DialogTitle className="mb-5">{title}</DialogTitle>{children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal></DialogPrimitive.Root>;
}
