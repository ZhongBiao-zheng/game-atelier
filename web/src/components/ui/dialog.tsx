import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { CloseIcon } from '@/components/ui/icons';
import { ConfirmDialog } from '@/components/ConfirmDialog';

import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>((props, ref) => <DialogPrimitive.Close {...props} ref={ref} data-connection-dismiss />);
DialogClose.displayName = DialogPrimitive.Close.displayName;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('scrim-fade fixed inset-0 z-50 bg-scrim', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** 有未保存输入的弹窗（规格 2.1）：传 `dirty` 后点外面不关，Esc 和右上角关闭先问「放弃未保存的修改？」；
 *  弹窗里自己的「取消」照常直接关闭。 */
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean; dirty?: boolean }
>(({ className, children, hideClose = false, dirty = false, onPointerDownOutside, onInteractOutside, onEscapeKeyDown, ...props }, ref) => {
  const [asking, setAsking] = React.useState(false);
  // 确认放弃后经一个隐藏的 Close 关掉弹窗：开合仍由调用方的 onOpenChange 决定，这里不接管 open。
  const discardRef = React.useRef<HTMLButtonElement>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'dialog-in fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-card p-5 text-popover-foreground focus:outline-none',
          className,
        )}
        onPointerDownOutside={event => {
          onPointerDownOutside?.(event);
          if (dirty) event.preventDefault();
        }}
        onInteractOutside={event => {
          onInteractOutside?.(event);
          if (dirty) event.preventDefault();
        }}
        onEscapeKeyDown={event => {
          onEscapeKeyDown?.(event);
          if (!dirty || event.defaultPrevented) return;
          event.preventDefault();
          setAsking(true);
        }}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            data-connection-dismiss
            aria-label="关闭"
            onClick={event => {
              if (!dirty) return;
              event.preventDefault();
              setAsking(true);
            }}
            className="absolute right-3 top-3 inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <CloseIcon aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
        {dirty && <DialogPrimitive.Close ref={discardRef} hidden tabIndex={-1} aria-hidden />}
        {(dirty || asking) && <ConfirmDialog
          open={asking}
          title="放弃未保存的修改？"
          message="关闭后这次填写的内容不会保留。"
          confirmText="放弃修改"
          cancelText="继续编辑"
          variant="destructive"
          onConfirm={() => {
            setAsking(false);
            discardRef.current?.click();
          }}
          onCancel={() => setAsking(false)}
        />}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('space-y-1.5 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-medium leading-none text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm leading-relaxed text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
