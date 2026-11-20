import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tasks } from './Tasks';
import { fetchGatewayTasks, type GatewayTask } from '@/api/gateway';
vi.mock('@/api/gateway', () => ({ fetchGatewayTasks: vi.fn(), gatewayOutputUrl: (id: string, i: number) => `/preview/${id}/${i}` }));

const task = (patch: Partial<GatewayTask> = {}): GatewayTask => ({ task_id: 't', kind: 'image', key_name: '小王', route_id: 'gpt', member_alias: 'HK', member_trail: ['HK'], phase: null, status: 'done', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:01:00Z', prompt: '海边的灯塔', n: 1, outputs: 0, output_types: [], error: null, ...patch });
afterEach(() => { vi.clearAllMocks(); });

it('labels a placeholder as a canceled submission without route, member or prompt', async () => {
  const placeholder = task({ task_id: 'p', route_id: '', member_alias: null, member_trail: [], status: 'canceled', prompt: '', n: 0, error: '已停止', placeholder: true });
  vi.mocked(fetchGatewayTasks).mockImplementation(async scope => scope === 'recent' ? [placeholder, task()] : []);
  render(<Tasks onFinished={vi.fn()} />);
  const label = await screen.findByText('已取消的提交');
  const row = label.closest('li')!;
  expect(within(row).getByText('小王')).toBeInTheDocument();
  expect(within(row).getByLabelText('已取消的提交说明')).toBeInTheDocument();
  expect(within(row).queryByText('已停止')).not.toBeInTheDocument();
  expect(within(row).queryByText('—')).not.toBeInTheDocument();
  // 普通任务照旧显示成员链与提示词。
  expect(screen.getAllByText('海边的灯塔').length).toBeGreaterThan(0);
  // 占位列出但不计数。
  expect(screen.getByText('最近 24 小时 · 1')).toBeInTheDocument();
});
