import * as React from 'react';
import { cn } from '@/lib/utils';
import { FOCUS_RING, INVALID_RING } from './focus';

/** 浏览器 / 密码管理器自动填充一律关闭；调用方显式传值可覆盖。 */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const;

export const inputClass = cn(
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm transition-[color,box-shadow,border-color] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
  FOCUS_RING,
  INVALID_RING,
);

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
