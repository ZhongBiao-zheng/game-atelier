import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { fetchUsage, fetchUsageTasks } from '@/api/usage';
import { fetchGateway, fetchGatewayProviderMe } from '@/api/gateway';
import { listKeys } from '@/api/keys';
import type { UsageResponse, UsageTask, UsageTasksResponse } from '@/schema/usage';
import { UsagePage } from './UsagePage';
import { QuotaCard } from './QuotaCard';
import { TaskTable } from './TaskTable';
import { KpiRow } from './KpiRow';
import { TrendChart } from './TrendChart';
vi.mock('@/api/usage', () => ({ fetchUsage: vi.fn(), fetchUsageTasks: vi.fn() }));
vi.mock('@/api/gateway', () => ({ fetchGateway: vi.fn(), fetchGatewayProviderMe: vi.fn() }));
vi.mock('@/api/keys', () => ({ listKeys: vi.fn() }));
const empty: UsageResponse = {
  scope: 'mine',
  range: '30d',
  bucket: 'week',
  totals: {
    cost_cny: 0,
    unpriced: 0,
    previous_cost_cny: 0,
    count: 0,
    by_kind: {},
    failed: 0,
    active_members: null,
    member_count: null,
  },
  trend: [],
  rankings: [],
  sources: ['local'],
  members: [{ id: 'k1', name: '小王' }],
};
beforeEach(() => {
  vi.mocked(fetchUsageTasks).mockReset().mockResolvedValue({ rows: [], total: 0, next_offset: null });
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
  expect(await screen.findByText(/本月 91¥/)).toHaveClass('text-[color:var(--status-running)]');
});

const task: UsageTask = {
  id: 'job-1', at: '2026-10-25T10:00:00Z', model: 'gpt-image-2', kind: 'image',
  alias: 'Tuzi', status: 'done', duration_s: 75, project_label: '测试项目', member_label: null,
  cost_cny: null, label: '测试项目', source: 'local', thumb_url: null, href: '/canvas/test',
};
const filters = { scope: 'mine' as const, range: '30d' as const, source: 'all' as const, member: '' };
it('趋势金额的无障碍标签和 tooltip 使用统一格式', () => {
  render(<TrendChart data={{ ...empty, trend: [{ start: '2026-10-27', cost_cny: 0.3 }] }} />);
  expect(screen.getByRole('img', { name: '2026-10-27 0.3¥' })).toHaveAttribute('title', '2026-10-27 · 0.3¥');
});
it('未计价独立显示次数与占比，零次隐藏', () => {
  const view = render(<KpiRow data={{ ...empty, totals: { ...empty.totals, count: 10, unpriced: 4 } }} />);
  expect(screen.getByText('未计价')).toBeInTheDocument();
  expect(screen.getByText('占 40.0%')).toBeInTheDocument();
  view.rerender(<KpiRow data={empty} />);
  expect(screen.queryByText('未计价')).not.toBeInTheDocument();
});
it('任务分页追加，切换筛选从头加载且费用和慢图片显示警告', async () => {
  vi.mocked(fetchUsageTasks).mockResolvedValueOnce({ rows: [task], total: 2, next_offset: 50 })
    .mockResolvedValueOnce({ rows: [{ ...task, id: 'job-2', model: 'second' }], total: 2, next_offset: null })
    .mockResolvedValueOnce({ rows: [], total: 0, next_offset: null });
  render(<TaskTable {...filters} />);
  const table = await screen.findByRole('table');
  expect(within(table).getByText('未计价')).toHaveClass('text-[color:var(--status-running)]');
  expect(within(table).getByText('1m 15s')).toHaveClass('text-[color:var(--status-running)]');
  expect(screen.getByRole('link', { name: '查看任务 job-1' })).toHaveAttribute('href', '/canvas/test');
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByText('second');
  expect(fetchUsageTasks).toHaveBeenNthCalledWith(2, { ...filters, status: 'all', offset: 50 });
  expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('group', { name: '状态筛选' })).getByRole('button', { name: '失败' }));
  await screen.findByText('暂无匹配的任务');
  expect(fetchUsageTasks).toHaveBeenLastCalledWith({ ...filters, status: 'failed', offset: 0 });
});
it('筛选改变后忽略旧分页响应，点击当前筛选不丢失请求', async () => {
  let resolveFirst!: (value: UsageTasksResponse) => void;
  let resolveMore!: (value: UsageTasksResponse) => void;
  vi.mocked(fetchUsageTasks).mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
    .mockReturnValueOnce(new Promise(resolve => { resolveMore = resolve; }))
    .mockResolvedValueOnce({ rows: [{ ...task, id: 'failed', status: 'failed', model: 'failure', cost_cny: 2 }], total: 1, next_offset: null });
  render(<TaskTable {...filters} />);
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  resolveFirst({ rows: [task], total: 2, next_offset: 50 });
  fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
  fireEvent.click(screen.getByRole('button', { name: '失败' }));
  await screen.findByText('failure');
  resolveMore({ rows: [{ ...task, id: 'stale', model: 'stale-page' }], total: 2, next_offset: null });
  await waitFor(() => expect(screen.getByRole('region', { name: '任务' })).toHaveAttribute('aria-busy', 'false'));
  expect(screen.queryByText('stale-page')).not.toBeInTheDocument();
  expect(screen.queryByText('gpt-image-2')).not.toBeInTheDocument();
});
it('团队任务替换成员列，不显示项目，未知耗时为横线', async () => {
  vi.mocked(fetchUsageTasks).mockResolvedValue({ rows: [{ ...task, project_label: null, member_label: '小王', duration_s: null }], total: 1, next_offset: null });
  render(<TaskTable {...filters} scope="team" member="k1" />);
  const table = await screen.findByRole('table');
  expect(within(table).getByRole('columnheader', { name: '成员' })).toBeInTheDocument();
  expect(within(table).queryByRole('columnheader', { name: '供应商' })).not.toBeInTheDocument();
  expect(within(table).getByText('小王')).toBeInTheDocument();
  expect(within(table).getAllByText('—')).toHaveLength(2);
  expect(fetchUsageTasks).toHaveBeenCalledWith({ ...filters, scope: 'team', member: 'k1', status: 'all', offset: 0 });
});
it('分页失败保留已有任务并允许重试', async () => {
  vi.mocked(fetchUsageTasks).mockResolvedValueOnce({ rows: [task], total: 2, next_offset: 50 })
    .mockRejectedValueOnce(new Error('读取失败'));
  render(<TaskTable {...filters} />);
  fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  expect(screen.getByText('gpt-image-2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '加载更多' })).toBeEnabled();
});
