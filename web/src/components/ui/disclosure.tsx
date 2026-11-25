import { useRef, useState, type ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Collapse } from './collapse';
import { FOCUS_RING } from './focus';

/** 折叠区，替代原生 <details>：标题行是带 aria-expanded 的按钮，内容区高度走 Collapse 展开收起。
 *  收起后内容仍留在 DOM 里（hidden），与 <details> 一样，表单字段的值不丢。
 *  收起时焦点若在内容里（受控收起、内容里的按钮触发收起），交还给标题行。
 *  受控传 open + onOpenChange，非受控传 defaultOpen。 */
export function Disclosure({ summary, open, defaultOpen = false, onOpenChange, className, triggerClassName, contentClassName, children }: {
  summary: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const expanded = open ?? uncontrolled;
  const toggle = () => {
    if (open === undefined) setUncontrolled(!expanded);
    onOpenChange?.(!expanded);
  };
  return (
    <div className={className}>
      <Button ref={triggerRef} variant="bare" type="button" aria-expanded={expanded} onClick={toggle}
        className={cn('flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground', FOCUS_RING, triggerClassName)}>
        <ChevronRightIcon size="sm" aria-hidden className={cn('shrink-0 transition-transform duration-150', expanded && 'rotate-90')} />
        {summary}
      </Button>
      <Collapse open={expanded} keepMounted onFocusEscape={() => triggerRef.current?.focus()} className={contentClassName}>{children}</Collapse>
    </div>
  );
}
