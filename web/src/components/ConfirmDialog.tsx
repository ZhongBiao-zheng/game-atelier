import { AlertTriangle } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

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
    <AlertDialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <AlertDialogContent>
        <div className="flex items-start gap-4">
          {variant === 'destructive' && (
            <div className="grid size-10 shrink-0 place-items-center rounded-full bg-destructive/10">
              <AlertTriangle className="size-5 text-destructive" aria-hidden />
            </div>
          )}
          <AlertDialogHeader className="min-w-0 flex-1">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{message}</AlertDialogDescription>
            {detail && (
              <p className="break-all whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                {detail}
              </p>
            )}
          </AlertDialogHeader>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelText}</AlertDialogCancel>
          {/* 关闭由调用方的 open 决定：阻止 Action 自带的关闭，否则会在确认后再触发一次 onCancel。 */}
          <AlertDialogAction
            destructive={variant === 'destructive'}
            onClick={event => { event.preventDefault(); onConfirm(); }}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
