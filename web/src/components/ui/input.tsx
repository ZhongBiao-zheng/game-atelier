import * as React from 'react';
import { cn } from '@/lib/utils';

/** 浏览器 / 密码管理器自动填充一律关闭；调用方显式传值可覆盖。 */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const;

const inputClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** bare：不带输入框配方，外观完全由 className 决定（画布内联编辑等特殊表面） */
  variant?: 'default' | 'bare';
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant = 'default', ...props }, ref) => {
    return (
      <input {...NO_AUTOFILL}
        type={type}
        ref={ref}
        className={variant === 'bare' ? className : cn(inputClass, className)}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
