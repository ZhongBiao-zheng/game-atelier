import * as React from 'react';
import { cn } from '@/lib/utils';

type ChoiceProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

const choiceClass = 'size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50';

/** 原生复选框。开关语义用 Switch。 */
export const Checkbox = React.forwardRef<HTMLInputElement, ChoiceProps>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="checkbox" className={cn(choiceClass, className)} {...props} />
  ),
);
Checkbox.displayName = 'Checkbox';

/** 原生单选框。 */
export const Radio = React.forwardRef<HTMLInputElement, ChoiceProps>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="radio" className={cn(choiceClass, className)} {...props} />
  ),
);
Radio.displayName = 'Radio';
