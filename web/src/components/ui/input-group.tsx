import * as React from 'react';

import { cn } from '@/lib/utils';
import { Input, type InputProps } from './input';

/** 带前后缀（图标、单位、按钮）的输入框。焦点环与错误态画在外框上。 */
export function InputGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        'flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-transparent transition-[color,box-shadow,border-color]',
        'has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-[3px] has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50',
        'has-[[data-slot=input-group-control][aria-invalid=true]]:border-destructive',
        'has-[>[data-align=inline-start]]:[&>input]:pl-0 has-[>[data-align=inline-end]]:[&>input]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

export function InputGroupAddon({ className, align = 'inline-start', ...props }: React.HTMLAttributes<HTMLDivElement> & {
  align?: 'inline-start' | 'inline-end';
}) {
  return (
    <div
      data-align={align}
      className={cn(
        'flex h-full shrink-0 items-center gap-2 px-3 text-sm text-muted-foreground [&>svg]:size-4',
        align === 'inline-end' && 'order-last',
        className,
      )}
      {...props}
    />
  );
}

export const InputGroupInput = React.forwardRef<HTMLInputElement, Omit<InputProps, 'variant'>>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      variant="bare"
      data-slot="input-group-control"
      className={cn('h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50', className)}
      {...props}
    />
  ),
);
InputGroupInput.displayName = 'InputGroupInput';
