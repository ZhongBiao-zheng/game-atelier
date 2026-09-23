import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TagField, parseTags } from './TagField';

describe('parseTags', () => {
  it('splits on both comma forms, trims and dedupes in order', () => {
    expect(parseTags(' 角色，概念图, 角色 ,, ')).toEqual(['角色', '概念图']);
  });
});

describe('TagField', () => {
  it('commits the draft on Enter and removes a tag', () => {
    const onChange = vi.fn();
    const view = render(<TagField value="角色" onChange={onChange} />);

    const input = screen.getByPlaceholderText('输入标签，按 Enter 添加');
    fireEvent.change(input, { target: { value: '概念图' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('角色, 概念图');

    view.rerender(<TagField value="角色, 概念图" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '移除标签 角色' }));
    expect(onChange).toHaveBeenLastCalledWith('概念图');
  });
});
