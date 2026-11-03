import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';
import { FOCUS_RING } from './focus';

export const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Root ref={ref} className={cn('flex flex-col gap-2', className)} {...props} />
));
Tabs.displayName = TabsPrimitive.Root.displayName;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: 'default' | 'line' }
>(({ className, variant = 'default', ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('inline-flex items-center text-muted-foreground', variant === 'line'
      ? 'h-11 w-full justify-start gap-5 border-b border-border'
      : 'h-9 w-fit justify-center rounded-lg bg-secondary p-1', className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { variant?: 'default' | 'line' }
>(({ className, variant = 'default', ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-full cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap text-sm transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
      variant === 'line' ? 'border-b-2 border-transparent px-0 font-normal data-[state=active]:border-primary data-[state=active]:font-medium'
        : 'flex-1 rounded-md border border-transparent px-2 font-medium data-[state=active]:bg-card',
      FOCUS_RING,
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('flex-1 outline-none', className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
