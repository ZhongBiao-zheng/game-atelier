import * as React from 'react';
import { cn } from '@/lib/utils';

/** 隐藏的文件选择框，由按钮或拖放区通过 ref.click() 触发。 */
export const FileInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="file" className={cn('sr-only', className)} {...props} />
  ),
);
FileInput.displayName = 'FileInput';
