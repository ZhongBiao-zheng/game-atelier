import * as React from 'react';
import { cn } from '@/lib/utils';

/** 原生滑杆。 */
export const Slider = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="range" className={cn('accent-primary', className)} {...props} />
  ),
);
Slider.displayName = 'Slider';
