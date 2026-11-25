import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import type { VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { SelectionHighlight } from './selection-highlight';
import { toggleVariants } from './toggle';

type ToggleVariants = VariantProps<typeof toggleVariants>;

const ToggleGroupContext = React.createContext<ToggleVariants & { sliding?: boolean }>({ size: 'default', variant: 'default' });

/** 单选 / 多选按钮组。type="single" 时再点已选项会得到空值，调用方忽略空值即可保持必选。
 *  sliding：单选组的选中底色改为一个跟着选中项滑动的独立层（同 Segmented），各项不再自己画选中底色；
 *  选项自带选中外观（色卡、反色图标）的组不要开。 */
export const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> & ToggleVariants & { sliding?: boolean }
>(({ className, variant, size, sliding = false, children, ...props }, ref) => {
  const slide = sliding && props.type === 'single';
  return (
    <ToggleGroupPrimitive.Root
      ref={ref}
      className={cn('flex w-fit items-center gap-1 rounded-md', slide && 'relative isolate', className)}
      {...props}
    >
      {slide && <SelectionHighlight className="ring-0" />}
      <ToggleGroupContext.Provider value={{ variant, size, sliding: slide }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
});
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & ToggleVariants
>(({ className, variant, size, ...props }, ref) => {
  const context = React.useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        toggleVariants({ variant: variant ?? context.variant, size: size ?? context.size }),
        context.sliding && 'data-[state=on]:bg-transparent data-[state=on]:hover:bg-transparent',
        className,
      )}
      {...props}
    />
  );
});
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;
