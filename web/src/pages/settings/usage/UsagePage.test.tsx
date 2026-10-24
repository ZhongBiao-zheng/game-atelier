import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { fetchUsage } from '@/api/usage';
import { fetchGateway, fetchGatewayProviderMe } from '@/api/gateway';
import { listKeys } from '@/api/keys';
import type { UsageResponse } from '@/schema/usage';
import { UsagePage } from './UsagePage';
import { QuotaCard } from './QuotaCard';
vi.mock('@/api/usage', () => ({ fetchUsage: vi.fn() }));
vi.mock('@/api/gateway', () => ({ fetchGateway: vi.fn(), fetchGatewayProviderMe: vi.fn() }));
vi.mock('@/api/keys', () => ({ listKeys: vi.fn() }));
const empty: UsageResponse = {
  scope: 'mine',
  range: '30d',
  bucket: 'week',
  totals: {
    cost_cny: 0,
    previous_cost_cny: 0,
    count: 0,
    by_kind: {},
    failed: 0,
    active_members: null,
    member_count: null,
  },
  trend: [],
  rankings: [],
  top: [],
  sources: ['local'],
  members: [{ id: 'k1', name: '小王' }],
};
beforeEach(() => {
  vi.mocked(fetchUsage).mockReset().mockResolvedValue(empty);
  vi.mocked(fetchGateway).mockResolvedValue({ enabled: true } as Awaited<ReturnType<typeof fetchGateway>>);
  vi.mocked(listKeys).mockResolvedValue({ keys: [] });
});
function setup(path = '/settings/usage') {
  const location = memoryLocation({ path, record: true });
  render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <UsagePage />
    </Router>,
  );
  return location;
}
describe('用量筛选', () => {
  it('切换团队和时间写入 URL', async () => {
    const location = setup();
    fireEvent.click(await screen.findByRole('button', { name: '团队' }));
    await waitFor(() => expect(location.history.at(-1)).toContain('scope=team'));
    fireEvent.click(screen.getByRole('button', { name: '7 天' }));
    await waitFor(() => expect(location.history.at(-1)).toContain('range=7d'));
    expect(fetchUsage).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'team', range: '7d' }));
  });
  it('网关未开启时不显示只剩「我的」的分段', async () => {
    vi.mocked(fetchGateway).mockResolvedValue({ enabled: false } as Awaited<ReturnType<typeof fetchGateway>>);
    setup();
    await waitFor(() => expect(fetchUsage).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '我的' })).toBeNull();
    expect(screen.queryByRole('button', { name: '团队' })).toBeNull();
  });
  it('来源根据区间内 sources 显示', async () => {
    vi.mocked(fetchUsage).mockResolvedValue({ ...empty, sources: ['local', 'lan'] });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '局域网' }));
    await waitFor(() =>
      expect(fetchUsage).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'lan' })),
    );
  });
  it('没有局域网来源时隐藏来源，并显示空数据', async () => {
    setup();
    expect(await screen.findByText('暂无用量记录')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '局域网' })).not.toBeInTheDocument();
  });
  it('网关关闭时隐藏团队并纠正 URL', async () => {
    vi.mocked(fetchGateway).mockResolvedValue({ enabled: false } as Awaited<ReturnType<typeof fetchGateway>>);
    const location = setup('/settings/usage?scope=team&member=k1');
    await screen.findByText('暂无用量记录');
    expect(screen.queryByRole('button', { name: '团队' })).not.toBeInTheDocument();
    expect(location.history.at(-1)).toContain('scope=mine');
    expect(location.history.at(-1)).not.toContain('member');
  });
  it('网关花费链接恢复成员选择', async () => {
    setup('/settings/usage?scope=team&member=k1');
    await screen.findByRole('option', { name: '小王' });
    expect(screen.getByRole('combobox', { name: '成员' })).toHaveValue('k1');
    expect(fetchUsage).toHaveBeenCalledWith(expect.objectContaining({ scope: 'team', member: 'k1' }));
  });
  it('切换加载时保留数据，失败显示错误', async () => {
    setup();
    await screen.findByText('暂无用量记录');
    let reject!: (error: Error) => void;
    vi.mocked(fetchUsage).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '7 天' }));
    expect(screen.getByText('暂无用量记录').parentElement).toHaveAttribute('aria-busy', 'true');
    reject(new Error('读取失败'));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
    expect(screen.getByText('暂无用量记录')).toBeInTheDocument();
  });
});
it('额度超过 90% 使用警告色', async () => {
  vi.mocked(listKeys).mockResolvedValue({ keys: [{ alias: 'Hub', provider: 'atelier' }] as never });
  vi.mocked(fetchGatewayProviderMe).mockResolvedValue({
    name: 'Hub',
    month_calls: 1,
    month_charged_cny: 91,
    limits: [
      {
        period: 'month',
        cap_cny: 100,
        used_cny: 91,
        reserved_cny: 0,
        left_cny: 9,
        resets_at: '2026-11-01T00:00:00+08:00',
      },
    ],
  });
  render(<QuotaCard />);
  expect(await screen.findByText(/本月 ¥ 91/)).toHaveClass('text-[color:var(--status-running)]');
});
