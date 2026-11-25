import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';

import { cn } from '@/lib/utils';
import { FOCUS_RING, INVALID_RING } from './focus';

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-3', className)} {...props} />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, onClick, onKeyDown, ...props }, ref) => {
  // 圆点缩放淡入只在用户碰过之后播（.indicator-pop），进页面时已选中的项不弹。
  const [touched, setTouched] = React.useState(false);
  return (
  <RadioGroupPrimitive.Item
    ref={ref}
    data-touched={touched ? '' : undefined}
    onClick={event => { setTouched(true); onClick?.(event); }}
    onKeyDown={event => { setTouched(true); onKeyDown?.(event); }}
    className={cn(
      'aspect-square size-4 shrink-0 cursor-pointer rounded-full border border-input bg-transparent text-primary transition-[color,box-shadow,border-color] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary',
      FOCUS_RING,
      INVALID_RING,
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="indicator-pop flex items-center justify-center">
      <span className="size-2 rounded-full bg-primary" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
  );
});
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;
