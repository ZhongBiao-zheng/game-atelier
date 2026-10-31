import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MJ_DEFAULTS } from '@/lib/mjParams';

import { MjControls } from './MjControls';

describe('MjControls', () => {
  it('EvoLink 固定 Fast Standard，仅展示已支持的参数', () => {
    render(<MjControls value={MJ_DEFAULTS} onChange={vi.fn()} evolink
      filledRefs={{ image: true, sref: true, cref: true, oref: true }} />);
    expect(screen.getByRole('button', { name: 'Midjourney 参数' })).toHaveTextContent('Fast · Standard');
    fireEvent.click(screen.getByRole('button', { name: 'Midjourney 参数' }));
    expect(screen.queryByLabelText('选择 Midjourney 模型')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择版本')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择速度档')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择角色权重')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择 Omni 权重')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('profile')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'sref 编号' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: '选择风格权重' })).toBeInTheDocument();
  });
  it('chaos 下方依次是 sref 与 profile，且粘贴完整 flag 时只保留参数值', () => {
    const onChange = vi.fn();
    render(<MjControls value={MJ_DEFAULTS} onChange={onChange} menuDirection="down" />);

    fireEvent.click(screen.getByRole('button', { name: 'Midjourney 参数' }));
    const chaos = screen.getByRole('radiogroup', { name: '选择混乱度' });
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
