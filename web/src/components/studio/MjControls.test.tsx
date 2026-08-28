import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MJ_DEFAULTS } from '@/lib/mjParams';

import { MjControls } from './MjControls';

describe('MjControls', () => {
  it('chaos 下方是 sref 编号输入，且状态只保留数字', () => {
    const onChange = vi.fn();
    render(<MjControls value={MJ_DEFAULTS} onChange={onChange} menuDirection="down" />);

    fireEvent.click(screen.getByRole('button', { name: 'Midjourney 参数' }));
    const chaos = screen.getByRole('listbox', { name: '选择混乱度' });
    const input = screen.getByRole('textbox', { name: 'sref 编号' });
    expect(chaos.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.change(input, { target: { value: '--sref 1967932137abc' } });
    expect(onChange).toHaveBeenLastCalledWith({ srefCode: '1967932137' });
  });
});
