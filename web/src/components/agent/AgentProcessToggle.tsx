import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronRightIcon, ToolIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/** 过程 / 思考过程的展开开关：图标 + 文案 + 旋转 chevron，内容由调用方放进 Collapse。 */
export function AgentProcessToggle({ label, open, onToggle, icon }: {
  label: string; open: boolean; onToggle: () => void; icon?: ReactNode;
}) {
  return <Button variant="bare" type="button" aria-expanded={open} onClick={onToggle}
    className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
    {icon ?? <ToolIcon size="sm" />}{label}
    <ChevronRightIcon size="sm" className={cn('transition-transform', open && 'rotate-90')} />
  </Button>;
}
