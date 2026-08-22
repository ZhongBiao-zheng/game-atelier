import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmText = '确认',
  cancelText = '取消',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <DialogContent>
        <div className="flex items-start gap-4">
          {variant === 'destructive' && (
            <div className="grid size-10 shrink-0 place-items-center rounded-full bg-destructive/10">
              <AlertTriangle className="size-5 text-destructive" aria-hidden />
            </div>
          )}
          <DialogHeader className="min-w-0 flex-1">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{message}</DialogDescription>
            {detail && (
              <p className="break-all whitespace-pre-wrap font-mono text-xs text-muted-foreground/70">
                {detail}
              </p>
            )}
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            type="button"
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
