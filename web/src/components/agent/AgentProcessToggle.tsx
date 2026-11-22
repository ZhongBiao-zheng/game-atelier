import { Button } from '@/components/ui/button';
import { ChevronRightIcon, ToolIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

export function AgentProcessToggle({ label, open, onToggle }: {
  label: string; open: boolean; onToggle: () => void;
}) {
  return <Button variant="bare" type="button" aria-expanded={open} onClick={onToggle}
    className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
    <ToolIcon size="sm" />{label}
    <ChevronRightIcon size="sm" className={cn('transition-transform', open && 'rotate-90')} />
  </Button>;
}
