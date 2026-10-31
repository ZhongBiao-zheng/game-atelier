import * as React from 'react';
import * as TogglePrimitive from '@radix-ui/react-toggle';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { FOCUS_RING } from './focus';

export const toggleVariants = cva(
  cn(
    'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium text-muted-foreground transition-[color,box-shadow,background-color] hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-secondary data-[state=on]:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    FOCUS_RING,
  ),
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border-input bg-transparent',
      },
      size: {
        default: 'h-9 min-w-9 px-2',
        sm: 'h-8 min-w-8 px-1.5 text-xs',
        lg: 'h-10 min-w-10 px-2.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
  <TogglePrimitive.Root ref={ref} className={cn(toggleVariants({ variant, size }), className)} {...props} />
));
Toggle.displayName = TogglePrimitive.Root.displayName;
