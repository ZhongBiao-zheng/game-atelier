import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  /** 读屏名称落在滑钮（role="slider"）上 */
  'aria-label'?: string;
};

export const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  ({ className, value, defaultValue, min = 0, max = 100, 'aria-label': ariaLabel, ...props }, ref) => {
    const thumbs = (value ?? defaultValue ?? [min]).length;
    return (
      <SliderPrimitive.Root
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        min={min}
        max={max}
        className={cn(
          'relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-16 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
          className,
        )}
        {...props}
      >
        <SliderPrimitive.Track className="relative grow overflow-hidden rounded-full bg-secondary data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5">
          <SliderPrimitive.Range className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full" />
        </SliderPrimitive.Track>
        {Array.from({ length: thumbs }, (_, index) => (
          <SliderPrimitive.Thumb
            key={index}
            aria-label={ariaLabel}
            className="block size-4 cursor-pointer rounded-full border border-primary bg-background transition-[color,box-shadow] hover:ring-4 hover:ring-ring/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/50 disabled:pointer-events-none"
          />
        ))}
      </SliderPrimitive.Root>
    );
  },
);
Slider.displayName = SliderPrimitive.Root.displayName;

/** 滑钮半宽（size-4）。Radix 把滑钮收在轨道内：值 p% 处滑钮中心 = p% + 半宽 × (1 - p / 50)。 */
const THUMB_HALF_PX = 8;

/** 滑杆下方的刻度数字，与滑钮中心对齐；当前值高亮。 */
export function SliderMarks({ min, max, marks, value, className }: {
  min: number;
  max: number;
  marks: number[];
  value?: number;
  className?: string;
}) {
  const span = max - min || 1;
  return (
    <div aria-hidden="true" className={cn('relative h-4 text-xs tabular-nums', className)}>
      {marks.map(mark => {
        const percent = ((mark - min) / span) * 100;
        return (
          <span
            key={mark}
            className={cn('absolute -translate-x-1/2', mark === value ? 'text-foreground' : 'text-muted-foreground')}
            style={{ left: `calc(${percent}% + ${THUMB_HALF_PX * (1 - percent / 50)}px)` }}
          >
            {mark}
          </span>
        );
      })}
    </div>
  );
}
