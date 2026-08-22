import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_HISTORY_FILTERS } from '@/lib/historyFilters';
import { StudioQueryBar } from './StudioQueryBar';

describe('StudioQueryBar', () => {
  it('三个筛选 chip 渲染可见标签（防 FilterChip 吞 children 回归）', () => {
    render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={vi.fn()} />);
    expect(screen.getByLabelText('时间筛选')).toHaveTextContent('时间');
    expect(screen.getByLabelText('生成模式筛选')).toHaveTextContent('生成模式');
    expect(screen.getByLabelText('操作类型筛选')).toHaveTextContent('操作类型');
  });

  it('点搜索展开输入框并回传 search', () => {
    const onChange = vi.fn();
    render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('搜索'));
    fireEvent.change(screen.getByPlaceholderText('搜索提示词…'), { target: { value: 'dragon' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'dragon' }));
  });

  it('生成模式可以独立加选、取消，且不影响其他已选项', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('生成模式筛选'));
    const listbox = screen.getByRole('listbox', { name: '生成模式列表' });
    expect(listbox).toHaveAttribute('aria-multiselectable', 'true');

    fireEvent.click(screen.getByRole('option', { name: /图片/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ modes: ['image'] }));

    onChange.mockClear();
    rerender(<StudioQueryBar filters={{ ...DEFAULT_HISTORY_FILTERS, modes: ['image'] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('option', { name: /视频/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ modes: ['image', 'video'] }));

    onChange.mockClear();
    rerender(<StudioQueryBar filters={{ ...DEFAULT_HISTORY_FILTERS, modes: ['image', 'video'] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('option', { name: /视频/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ modes: ['image'] }));

    onChange.mockClear();
    rerender(<StudioQueryBar filters={{ ...DEFAULT_HISTORY_FILTERS, modes: ['image'] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('option', { name: /图片/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ modes: [] }));
  });

  it('点选选项后面板保持展开', () => {
    render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('时间筛选'));
    fireEvent.click(screen.getByRole('option', { name: '最近一周' }));
    expect(screen.getByRole('listbox', { name: '时间筛选列表' })).toBeInTheDocument();
  });

  it('操作类型选喜欢回传 op=favorite', () => {
    const onChange = vi.fn();
    render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('操作类型筛选'));
    fireEvent.click(screen.getByRole('option', { name: /喜欢/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ op: 'favorite' }));
  });
});
