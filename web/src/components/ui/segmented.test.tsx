import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Segmented, SegmentedItem } from './segmented';

describe('Segmented 选中描边', () => {
  it('描边在滑块内侧，调用方 hover 类不会覆盖选中态透明规则', () => {
    const onSelect = vi.fn();
    const { container } = render(<Segmented aria-label="测试参数">
      <SegmentedItem value="one" selected onSelect={onSelect} className="hover:bg-secondary/60">一</SegmentedItem>
      <SegmentedItem value="two" selected={false} onSelect={onSelect}>二</SegmentedItem>
    </Segmented>);
    const selected = screen.getByRole('radio', { name: '一' });
    expect(selected).toHaveAttribute('data-state', 'on');
    expect(selected).toHaveClass('hover:bg-secondary/60', 'data-[state=on]:hover:bg-transparent');
    expect(container.querySelector('[aria-hidden="true"]')).toHaveClass('ring-inset');
    fireEvent.click(screen.getByRole('radio', { name: '二' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
