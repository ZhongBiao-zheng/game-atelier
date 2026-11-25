import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';

import { cn } from '@/lib/utils';
import { FOCUS_RING } from './focus';

/** 开关。滑块位移与底色只在用户碰过它之后才过渡：进页面时设置晚一步读回来，开关直接落在该在的位置，不自己滑一下。
 *  减弱动态效果时只留颜色淡变，滑块直接到位。 */
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { size?: 'sm' | 'default' }
>(({ className, size = 'default', onClick, onKeyDown, ...props }, ref) => {
  const [touched, setTouched] = React.useState(false);
  return (
    <SwitchPrimitive.Root
      ref={ref}
      data-size={size}
      data-touched={touched ? '' : undefined}
      onClick={event => { setTouched(true); onClick?.(event); }}
      onKeyDown={event => { setTouched(true); onKeyDown?.(event); }}
      className={cn(
        'group/switch peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-none data-[touched]:transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block rounded-full transition-none group-data-[touched]/switch:transition-[translate,background-color] motion-reduce:group-data-[touched]/switch:transition-colors data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-foreground',
          size === 'sm' ? 'size-3 data-[state=checked]:translate-x-3' : 'size-4 data-[state=checked]:translate-x-4',
        )}
      />
    </SwitchPrimitive.Root>
  );
});
Switch.displayName = SwitchPrimitive.Root.displayName;
