import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';

import { cn } from '@/lib/utils';
import { FOCUS_RING } from './focus';
import { SelectionHighlight } from './selection-highlight';

interface SegmentedItemProps extends Omit<React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>, 'onSelect'> {
  /** 是否为当前选中项；选中态由各项自己声明，组上不再另存一份值。 */
  selected: boolean;
  onSelect: () => void;
}

/** 分段单选：ToggleGroup 单选 + 跟随选中项滑动的底色。再点已选项不会取消选择。 */
export function Segmented({ className, children, ...props }: Omit<
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>, 'type' | 'value' | 'defaultValue' | 'onValueChange'
>) {
  const items = React.Children.toArray(children)
    .filter((child): child is React.ReactElement<SegmentedItemProps> => React.isValidElement(child) && child.type === SegmentedItem);
  const value = items.find(item => item.props.selected)?.props.value ?? '';
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={next => { if (next) items.find(item => item.props.value === next)?.props.onSelect(); }}
      className={cn('relative isolate grid rounded-lg bg-popover p-0.5', className)}
      {...props}
    >
      <SelectionHighlight />
      {children}
    </ToggleGroupPrimitive.Root>
  );
}

export const SegmentedItem = React.forwardRef<React.ElementRef<typeof ToggleGroupPrimitive.Item>, SegmentedItemProps>(
  ({ className, selected: _selected, onSelect: _onSelect, ...props }, ref) => (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn('h-8 min-w-0 cursor-pointer rounded-md text-center text-sm transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50', FOCUS_RING, className)}
      {...props}
    />
  ),
);
SegmentedItem.displayName = 'SegmentedItem';
