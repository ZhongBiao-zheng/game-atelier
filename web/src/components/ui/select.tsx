import * as React from 'react';
import { cn } from '@/lib/utils';

// 箭头与右内边距由 tokens.css 的 select base 规则统一，这里只给与输入框相同的边框 / 圆角 / 高度。
const selectClass = 'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** bare：不带选择框配方，外观完全由 className 决定 */
  variant?: 'default' | 'bare';
}

/** 原生下拉。 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <select ref={ref} className={variant === 'bare' ? className : cn(selectClass, className)} {...props} />
  ),
);
Select.displayName = 'Select';
