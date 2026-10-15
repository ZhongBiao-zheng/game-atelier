import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RegionalEditControls } from './RegionalEditControls';

const regions = [
  { id: '1-2', components: [1, 2], bounds: [0, 0, 50, 50], crop: [0, 0, 256, 256],
    work_size: [1024, 1024], params: { size: '1024x1024' }, feather: 8, preview: '' },
  { id: '3', components: [3], bounds: [600, 600, 650, 650], crop: [500, 500, 256, 256],
    work_size: [1024, 1024], params: { size: '1024x1024' }, feather: 8, preview: '' },
];

describe('regional editing controls', () => {
  function mount() {
    const onGroups = vi.fn();
    const onPrompt = vi.fn();
    render(<RegionalEditControls regions={regions} activeId="1-2" onActive={vi.fn()}
      context={.25} feather={null} onContext={vi.fn()} onFeather={vi.fn()}
      prompts={{}} defaultPrompt="修复地板" onPrompt={onPrompt} onGroups={onGroups} />);
    return { onGroups, onPrompt };
  }
  it('shows the crop-to-work transform and edits a selected region prompt', () => {
    const { onPrompt } = mount();
    expect(screen.getByText('256 × 256 → 1024 × 1024')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('区域提示词'), { target: { value: '移除垃圾' } });
    expect(onPrompt).toHaveBeenCalledWith('1-2', '移除垃圾');
    expect(screen.getByLabelText('区域提示词')).toHaveAttribute('placeholder', '修复地板');
  });
  it('splits a group without losing any component', () => {
    const { onGroups } = mount();
    fireEvent.click(screen.getByRole('button', { name: '拆开此区' }));
    expect(onGroups).toHaveBeenCalledWith([[1], [2], [3]]);
  });
  it('merges only checked groups and keeps feather adjustable to zero', () => {
    const { onGroups } = mount();
    fireEvent.click(screen.getByLabelText('合并选择区域 1'));
    fireEvent.click(screen.getByLabelText('合并选择区域 2'));
    fireEvent.click(screen.getByRole('button', { name: '合并所选' }));
    expect(onGroups).toHaveBeenCalledWith([[1, 2, 3]]);
    expect(screen.getByLabelText('边缘融合')).toHaveAttribute('min', '0');
  });
});
