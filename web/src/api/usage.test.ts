import { expect, it, vi } from 'vitest';
import { fetchUsageTasks } from './usage';
import { requestJson } from './http';

vi.mock('./http', () => ({ requestJson: vi.fn().mockResolvedValue({ rows: [], total: 0, next_offset: null }) }));

it('任务查询编码筛选值并省略空值，本机与中转使用相同参数', async () => {
  const params = { scope: 'mine' as const, range: '30d' as const, source: 'all' as const,
    member: '', status: 'all' as const, offset: 50, project: 'canvas:项目', model: 'gpt-image-2', alias: '', kind: 'image' };
  for (const gateway of [undefined, 'Relay']) {
    await fetchUsageTasks(params, gateway);
    const [path] = vi.mocked(requestJson).mock.calls.at(-1)!;
    const url = new URL(path, 'http://localhost');
    expect(url.pathname).toBe(gateway ? '/api/gateway/providers/Relay/admin/usage/tasks' : '/api/usage/tasks');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: 'mine', range: '30d', source: 'all', status: 'all', offset: '50', limit: '50',
      project: 'canvas:项目', model: 'gpt-image-2', kind: 'image',
    });
  }
});
