import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function AssetFilterPill({ selected, className, ...props }: ButtonProps & { selected: boolean }) {
  return <Button variant="ghost" size="sm" aria-pressed={selected} {...props}
    className={cn('h-7 rounded-full border-border px-3 text-xs font-normal',
      selected ? 'bg-secondary text-foreground' : 'text-muted-foreground', className)} />;
}
