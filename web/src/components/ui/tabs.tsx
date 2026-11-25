import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';
import { FOCUS_RING } from './focus';
import { SelectionHighlight } from './selection-highlight';

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
>(({ className, variant = 'default', children, ...props }, ref) => (
  // 选中指示是一个跟着选中项滑动的独立层（底色或下划线），页签本身只换文字颜色；切页签的正文仍是瞬切。
  <TabsPrimitive.List
    ref={ref}
    className={cn('relative isolate inline-flex items-center text-muted-foreground', variant === 'line'
      ? 'h-11 w-full justify-start gap-5 border-b border-border'
      : 'h-9 w-fit justify-center rounded-lg bg-secondary p-1', className)}
    {...props}
  >
    <SelectionHighlight variant={variant === 'line' ? 'underline' : 'fill'} className={variant === 'line' ? undefined : 'bg-card ring-0'} />
    {children}
  </TabsPrimitive.List>
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
      // 线型页签选中与否同一字重：换字重会改宽度，旁边的页签跟着挪。
      variant === 'line' ? 'px-0 font-medium' : 'flex-1 rounded-md border border-transparent px-2 font-medium',
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
