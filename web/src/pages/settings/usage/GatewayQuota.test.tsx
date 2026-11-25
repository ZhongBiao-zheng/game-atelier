import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fetchGatewayProviderMe, type GatewayMe } from '@/api/gateway';
import { GatewayQuota } from './GatewayQuota';

vi.mock('@/api/gateway', () => ({ fetchGatewayProviderMe: vi.fn() }));

// 第 7 批：新主机回一条 quota（可能不重置）；旧主机只回 limits（可能多条）。
const base = { name: '小王', month_charged_cny: 0, month_calls: 0 };
const status = { cap_cny: 10, used_cny: 2, reserved_cny: 1, left_cny: 7 };

describe('成员端的团队网关额度', () => {
  it('新主机：只显示 quota 这一条；不重置时写「不重置」', async () => {
    vi.mocked(fetchGatewayProviderMe).mockResolvedValue({ ...base, quota: { ...status, period: 'none', resets_at: null },
      limits: [] } satisfies GatewayMe);
    render(<GatewayQuota alias="美术组网关" />);
    expect(await screen.findByLabelText('团队网关额度')).toHaveTextContent(/累计 .*3.* \/ .*10.* · 不重置/);
  });

  it('新主机不限额：不显示', async () => {
    vi.mocked(fetchGatewayProviderMe).mockResolvedValue({ ...base, quota: null, limits: [] });
    render(<GatewayQuota alias="美术组网关" />);
    expect(await screen.findByLabelText('团队网关额度')).toBeEmptyDOMElement();
  });

  it('旧主机（没有 quota）：照旧显示 limits 的每一条', async () => {
    vi.mocked(fetchGatewayProviderMe).mockResolvedValue({ ...base, limits: [
      { ...status, period: 'day', resets_at: '2026-11-21T00:00:00+08:00' },
      { ...status, period: 'month', resets_at: '2026-12-01T00:00:00+08:00' },
    ] });
    render(<GatewayQuota alias="美术组网关" />);
    const box = await screen.findByLabelText('团队网关额度');
    expect(box).toHaveTextContent('今日');
    expect(box).toHaveTextContent('本月');
    expect(box).toHaveTextContent('重置');
  });
});
