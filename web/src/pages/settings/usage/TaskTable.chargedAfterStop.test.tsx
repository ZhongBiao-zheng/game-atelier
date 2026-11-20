import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { fetchUsageTasks } from '@/api/usage';
import type { UsageTask } from '@/schema/usage';
import { TaskTable } from './TaskTable';

vi.mock('@/api/usage', () => ({ fetchUsageTasks: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); });

const task = (patch: Partial<UsageTask>): UsageTask => ({
  id: 't', cost_cny: 0.5, at: '2026-11-20T03:00:00Z', kind: 'image', model: 'gpt-image-2', label: '创作台',
  source: 'lan', prompt: null, thumb_url: null, href: null, alias: 'Hub', status: 'done', duration_s: 30,
  project_label: '创作台', member_label: null, project_key: 'studio', member_key: null, ...patch,
});

it('已停止但扣了费的任务注明「已扣费」并说明来由；没扣费的已停止照旧', async () => {
  vi.mocked(fetchUsageTasks).mockResolvedValue({ total: 2, next_offset: null, rows: [
    task({ id: 'charged', status: 'canceled', cost_cny: 0.5 }),
    task({ id: 'free', status: 'canceled', cost_cny: 0, model: 'other-model' }),
  ] });
  render(<Router><TaskTable scope="mine" range="30d" source="all" member="" /></Router>);
  const charged = await screen.findByText(/已取消 · 已扣费/);
  expect(charged.closest('[tabindex="0"]')).not.toBeNull();  // 有说明（「?」式提示，可聚焦）
  const rows = screen.getAllByRole('row');
  const free = rows.find(row => within(row).queryByText('other-model'))!;
  expect(within(free).getByText('已取消')).toBeInTheDocument();
  expect(within(free).queryByText(/已扣费/)).toBeNull();
});
