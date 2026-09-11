import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MJ_DEFAULTS } from '@/lib/mjParams';

import { MjControls } from './MjControls';

describe('MjControls', () => {
  it('chaos 下方依次是 sref 与 profile，且粘贴完整 flag 时只保留参数值', () => {
    const onChange = vi.fn();
    render(<MjControls value={MJ_DEFAULTS} onChange={onChange} menuDirection="down" />);

    fireEvent.click(screen.getByRole('button', { name: 'Midjourney 参数' }));
    const chaos = screen.getByRole('listbox', { name: '选择混乱度' });
    const srefInput = screen.getByRole('textbox', { name: 'sref 编号' });
    const profileInput = screen.getByRole('textbox', { name: 'profile' });
    expect(chaos.compareDocumentPosition(srefInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(srefInput.compareDocumentPosition(profileInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.change(srefInput, { target: { value: '--sref 1967932137abc' } });
    expect(onChange).toHaveBeenLastCalledWith({ srefCode: '1967932137' });

    fireEvent.change(profileInput, { target: { value: '--profile e6wl24r' } });
    expect(onChange).toHaveBeenLastCalledWith({ profile: 'e6wl24r' });

    const callCount = onChange.mock.calls.length;
    fireEvent.change(profileInput, { target: { value: 'e6w-l24r' } });
    expect(onChange).toHaveBeenCalledTimes(callCount);
  });
});
