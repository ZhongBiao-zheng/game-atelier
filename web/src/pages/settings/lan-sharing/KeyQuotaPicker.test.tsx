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
// 弹层不做隐式保存（规格 2.5）：点「保存」才存。
const save = () => fireEvent.click(screen.getByRole('button', { name: '保存' }));

describe('成员行「额度」弹层', () => {
  function openQuota(record: GatewayKey) {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<KeyQuotaPicker record={record} busy={false} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: '额度' }));
    return onSave;
  }

  it('填金额、选周期，点保存存一条额度', async () => {
    const onSave = openQuota(key());
    fireEvent.change(screen.getByLabelText('额度金额'), { target: { value: '10' } });
    await chooseOption(screen.getByLabelText('额度周期'), '每天');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ quota: { cap_cny: 10, period: 'day' } }));
  });

  it('只改周期为不重置', async () => {
    const onSave = openQuota(key({ quota: { cap_cny: 10, period: 'day' } }));
    await chooseOption(screen.getByLabelText('额度周期'), '不重置');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ quota: { cap_cny: 10, period: 'none' } }));
  });

  it('清空金额保存为不限额', async () => {
    const onSave = openQuota(key({ quota: { cap_cny: 10, period: 'week' } }));
    fireEvent.change(screen.getByLabelText('额度金额'), { target: { value: '' } });
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ quota: null }));
  });

  it('非法金额留在弹层并提示', () => {
    const onSave = openQuota(key());
    fireEvent.change(screen.getByLabelText('额度金额'), { target: { value: '0' } });
    save();
    expect(screen.getByRole('alert')).toHaveTextContent('额度须大于 0 且不超过 100 万');
    expect(onSave).not.toHaveBeenCalled();
  });

  // R8：type=number 里输入「1e」「-」时 value 是空串；不能当成「清空即不限」把额度删掉。
  it('输入读不成数字时不保存、不关闭，提示无效', () => {
    const onSave = openQuota(key({ quota: { cap_cny: 10, period: 'day' } }));
    const input = screen.getByLabelText('额度金额') as HTMLInputElement;
    Object.defineProperty(input, 'validity', { configurable: true, value: { ...input.validity, badInput: true } });
    fireEvent.change(input, { target: { value: '' } });
    save();
    expect(screen.getByRole('alert')).toHaveTextContent('额度须大于 0 且不超过 100 万');
    expect(screen.getByLabelText('额度')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  // R2：旧主机的真实形状——记录里没有 quota 键。
  it('旧主机：只提示更新，关上不保存', () => {
    const { quota: _omitted, ...oldHostRecord } = key();
    const onSave = openQuota(oldHostRecord as GatewayKey);
    expect(screen.getByText('主机版本较旧，更新主机后才能设置')).toBeInTheDocument();
    close('额度');
    expect(screen.queryByLabelText('额度')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
