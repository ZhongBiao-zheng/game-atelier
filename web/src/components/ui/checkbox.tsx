import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { CheckIcon } from '@/components/ui/icons';

import { cn } from '@/lib/utils';
import { FOCUS_RING, INVALID_RING } from './focus';

/** 多选。开关语义（立即生效的启用 / 停用）用 Switch。
 *  勾号缩放淡入、取消时缩回淡出（.indicator-pop），只在用户碰过之后播：打开一列已勾选的清单时不会一起弹。 */
export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, onClick, onKeyDown, ...props }, ref) => {
  const [touched, setTouched] = React.useState(false);
  return (
  <CheckboxPrimitive.Root
    ref={ref}
    data-touched={touched ? '' : undefined}
    onClick={event => { setTouched(true); onClick?.(event); }}
    onKeyDown={event => { setTouched(true); onKeyDown?.(event); }}
    className={cn(
      'peer size-4 shrink-0 cursor-pointer rounded-sm border border-input bg-transparent transition-[color,background-color,box-shadow,border-color] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      FOCUS_RING,
      INVALID_RING,
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="indicator-pop grid place-content-center text-current">
      <CheckIcon size="sm" aria-hidden="true" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
  );
});
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
