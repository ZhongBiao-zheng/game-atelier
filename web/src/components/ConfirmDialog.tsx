import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim">
      <div
        className="bg-popover border border-border rounded-xl p-6 max-w-md w-full mx-4"
        style={{ animation: 'dialogIn 150ms ease-out' }}
      >
        <div className="flex items-start gap-4">
          {variant === 'destructive' && (
            <div className="shrink-0 size-10 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="size-5 text-destructive" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-medium text-foreground mb-2">{title}</h3>
            <p className="text-sm text-muted-foreground mb-1">{message}</p>
            {detail && (
              <p className="text-xs font-mono text-muted-foreground/70 break-all whitespace-pre-wrap">
                {detail}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}

// 样式注入（符合 Tailwind 约定）
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes dialogIn {
      from { opacity: 0; transform: scale(0.96) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
  `;
  if (!document.querySelector('style[data-dialog-keyframes]')) {
    style.setAttribute('data-dialog-keyframes', 'true');
    document.head.appendChild(style);
  }
}
