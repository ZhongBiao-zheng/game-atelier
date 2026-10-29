import * as React from 'react';
import { cn } from '@/lib/utils';
import { NO_AUTOFILL } from './input';

const textareaClass = 'flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** bare：不带输入框配方，外观完全由 className 决定（提示词壳、标注文字等特殊表面） */
  variant?: 'default' | 'bare';
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <textarea {...NO_AUTOFILL}
        ref={ref}
        className={variant === 'bare' ? className : cn(textareaClass, className)}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
