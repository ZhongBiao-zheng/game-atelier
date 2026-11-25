import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/utils';

const TOOLTIP_DELAY_MS = 300;
const InSharedTooltipProvider = React.createContext(false);

/** 应用根部挂一次。所有提示共用一个 Provider，相邻按钮间移动时跳过等待、直接切换（不再逐个等 300ms）。 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={TOOLTIP_DELAY_MS}>
      <InSharedTooltipProvider.Provider value>{children}</InSharedTooltipProvider.Provider>
    </TooltipPrimitive.Provider>
  );
}

/** 在共享 Provider 里直接挂 Root；单独渲染（组件测试、插件宿主）时自带一个 Provider 兜底。 */
export function Tooltip({ delayDuration, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root> & { delayDuration?: number }) {
  const shared = React.useContext(InSharedTooltipProvider);
  if (shared) return <TooltipPrimitive.Root delayDuration={delayDuration} {...props} />;
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration ?? TOOLTIP_DELAY_MS}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  );
}

export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'popover-in z-50 w-fit max-w-xs whitespace-pre-line text-balance rounded-md bg-foreground px-3 py-1.5 text-xs text-background',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/** 给单个元素挂提示（替代原生 title）。子元素必须能接收 ref；label 为空时原样渲染子元素。 */
export function Hint({ label, side, children }: {
  label: React.ReactNode;
  side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>['side'];
  children: React.ReactElement;
}) {
  if (label === undefined || label === null || label === false || label === '') return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
