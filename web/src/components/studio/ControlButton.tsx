import type { ButtonHTMLAttributes } from 'react';
import { Button } from '@/components/ui/button';

export function ControlButton({
  active,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <Button variant="bare"
      type="button"
      className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-border bg-secondary text-foreground'
          : 'border-border text-foreground hover:bg-secondary'
      } ${className}`}
      {...props}
    />
  );
}
