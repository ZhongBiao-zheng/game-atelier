import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GatewayKey } from '@/api/gateway';
import { chooseOption } from '@/test/select';
import { KeyQuotaPicker } from './KeyQuotaPicker';

// 第 7 批：额度是一个金额 + 一个周期（每天 / 每周 / 每月 / 不重置）。

function key(overrides: Partial<GatewayKey> = {}): GatewayKey {
  return {
    id: 'k1', name: '小王', role: 'member', quota: null, scope: null, quota_status: null,
    created_at: '', revoked_at: null, month_charged_cny: 0, month_calls: 0, last_used_at: null, ...overrides,
  };
}

const close = (label: string) => fireEvent.keyDown(screen.getByLabelText(label), { key: 'Escape' });

describe('成员行「额度」弹层', () => {
  function openQuota(record: GatewayKey) {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<KeyQuotaPicker record={record} busy={false} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: '额度' }));
    return onSave;
  }

  it('填金额、选周期，关闭时保存一条额度', async () => {
    const onSave = openQuota(key());
    fireEvent.change(screen.getByLabelText('额度金额'), { target: { value: '10' } });
    await chooseOption(screen.getByLabelText('额度周期'), '每天');
    close('额度');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ quota: { cap_cny: 10, period: 'day' } }));
  });

  it('只改周期为不重置', async () => {
    const onSave = openQuota(key({ quota: { cap_cny: 10, period: 'day' } }));
    await chooseOption(screen.getByLabelText('额度周期'), '不重置');
    close('额度');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ quota: { cap_cny: 10, period: 'none' } }));
  });

  it('清空金额保存为不限额', async () => {
    const onSave = openQuota(key({ quota: { cap_cny: 10, period: 'week' } }));
    fireEvent.change(screen.getByLabelText('额度金额'), { target: { value: '' } });
    close('额度');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ quota: null }));
  });

  it('非法金额留在弹层并提示', () => {
    const onSave = openQuota(key());
    fireEvent.change(screen.getByLabelText('额度金额'), { target: { value: '0' } });
    close('额度');
    expect(screen.getByRole('alert')).toHaveTextContent('额度须大于 0 且不超过 100 万');
    expect(onSave).not.toHaveBeenCalled();
  });
});
