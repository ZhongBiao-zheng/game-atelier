import type { ReactNode } from 'react';

export function MetaTag({ children, className = '', onClick, disabled = false }: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const style = `inline-flex items-center gap-1 rounded-sm bg-card px-2 py-0.5 text-xs tabular-nums ${className}`;
  return onClick ? <button type="button" aria-disabled={disabled}
    title={disabled ? '当前模型不支持' : undefined}
    onClick={disabled ? undefined : onClick}
    className={`${style} ${disabled ? 'cursor-default' : 'hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary'}`}>
    {children}
  </button> : <span className={style}>{children}</span>;
}
