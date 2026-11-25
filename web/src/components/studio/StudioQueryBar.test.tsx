import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_HISTORY_FILTERS } from '@/lib/historyFilters';
import { StudioQueryBar } from './StudioQueryBar';

describe('StudioQueryBar', () => {
  it('三组筛选收在一个「筛选」入口里，面板内分组展示', () => {
    render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: '筛选' });
    expect(chip).toHaveTextContent('筛选');
    expect(chip).not.toHaveClass('text-primary');
    fireEvent.click(chip);
    for (const name of ['时间筛选列表', '生成模式列表', '操作类型列表']) {
      expect(screen.getByRole('listbox', { name })).toBeInTheDocument();
    }
  });

  it('点搜索展开输入框并回传 search', () => {
    const onChange = vi.fn();
    render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('搜索'));
    fireEvent.change(screen.getByPlaceholderText('搜索提示词…'), { target: { value: 'dragon' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'dragon' }));
  });

  it('有筛选时入口显示条数与主题色，名称带出当前值，恢复默认后还原', () => {
    const { rerender } = render(<StudioQueryBar filters={{ ...DEFAULT_HISTORY_FILTERS, time: '1w', modes: ['video', 'image'], op: 'favorite' }} onChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: '筛选：最近一周，图片、视频，喜欢' });
    expect(chip).toHaveTextContent('筛选3');
    expect(chip).toHaveClass('text-primary');
    expect(chip.querySelector('svg')).toHaveClass('text-primary');
    rerender(<StudioQueryBar filters={{ ...DEFAULT_HISTORY_FILTERS, time: '3m' }} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '筛选：最近三个月' })).toHaveTextContent('筛选1');
    rerender(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '筛选' })).not.toHaveClass('text-primary');
  });

  it('生成模式可以独立加选、取消，且不影响其他已选项', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
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
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.click(screen.getByRole('option', { name: '最近一周' }));
    expect(screen.getByRole('listbox', { name: '时间筛选列表' })).toBeInTheDocument();
  });

  it('操作类型选喜欢回传 op=favorite', () => {
    const onChange = vi.fn();
    render(<StudioQueryBar filters={DEFAULT_HISTORY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.click(screen.getByRole('option', { name: /喜欢/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ op: 'favorite' }));
  });
});
