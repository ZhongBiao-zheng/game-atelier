import type { ReactNode } from 'react';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

export function MetaTag({ children, className = '', onClick, disabled = false, disabledReason }: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const style = `inline-flex items-center gap-1 rounded-sm bg-card px-2 py-0.5 text-xs tabular-nums ${className}`;
  return onClick ? <Hint label={disabled ? disabledReason : undefined}><Button variant="bare" type="button" aria-disabled={disabled}
    onClick={disabled ? undefined : onClick}
    className={`${style} ${disabled ? 'cursor-default' : 'hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary'}`}>
    {children}
  </Button></Hint> : <span className={style}>{children}</span>;
}
