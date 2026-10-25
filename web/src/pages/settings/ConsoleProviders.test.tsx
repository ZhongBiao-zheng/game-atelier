import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProviderRow } from '@/components/keys/ProviderRow';
import { KeysPage } from './Keys';
import { ModelRoutesSection } from './ModelRoutesSection';
import { ProviderAddPage } from './ProviderAddPage';
import * as keys from '@/api/keys';
import * as gateway from '@/api/gateway';
vi.mock('@/api/keys', async original => ({
  ...await original<typeof import('@/api/keys')>(),
  patchKey: vi.fn().mockResolvedValue(undefined),
  listKeys: async () => ({ keys: [
    { alias: 'local', provider: 'custom', base_url: 'https://models.example.com/v1', access_key: '***', models: [] },
    { alias: 'lan', provider: 'atelier', access_key: '***', models: [] },
  ] }),
}));
vi.mock('@/api/usage', () => ({
  fetchKeyLastUsed: async () => ({ local: new Date().toISOString() }),
}));
vi.mock('@/api/models', () => ({
  listModelRoutes: async () => [{ id: 'gpt', name: 'GPT', modality: 'image', members: [
    { alias: 'A', provider: 'custom' }, { alias: 'B', provider: 'custom' },
  ] }], setModelRouteOrder: vi.fn(),
}));
vi.mock('@/api/gateway', () => ({
  fetchGatewayMembers: async () => ({
    members: [{ modality: 'image', alias: 'A', since: '2026-10-24T00:00:00Z', route_ids: ['gpt'] }],
    unavailable_routes: [{ id: 'gpt', name: 'GPT', modality: 'image' }],
  }),
  restoreGatewayMember: vi.fn().mockResolvedValue({ members: [], unavailable_routes: [] }),
}));
it('局域网排第一且不显示额度', async () => {
  render(<KeysPage embedded />);
  await screen.findByText('lan');
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('lan');
  expect(rows[1]).toHaveTextContent('local');
  expect(screen.queryByLabelText('中转额度')).not.toBeInTheDocument();
  expect(rows[1]).toHaveTextContent('正常');
  expect(rows[0]).toHaveTextContent('未用过');
  expect(screen.getByRole('link', { name: '添加供应商' })).toHaveAttribute('href', '/settings/providers/new');
});
it('添加页按供应商、中转和团队分组，支持查找与地址校验', async () => {
  render(<ProviderAddPage />);
  expect(await screen.findByText('已添加')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '供应商' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '中转' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '团队' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Tuzi/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /OpenAI-HK/ })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '查找供应商' }), { target: { value: 'Tuzi' } });
  expect(screen.getByRole('button', { name: /Tuzi/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /OpenAI-HK/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '自定义供应商地址' }), { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  expect(screen.getByRole('alert')).toHaveTextContent('请输入完整的 HTTP(S) API 请求地址');
});
it('custom 预设按域名识别已添加，不把所有中转都标为已添加', async () => {
  vi.spyOn(keys, 'listKeys').mockResolvedValueOnce({ keys: [{ alias: '我的兔子', provider: 'custom',
    base_url: 'https://api.tu-zi.com/v1', access_key: '***', secret_key: null, models: [], capabilities: [], notes: '', created_at: '' }] });
  render(<ProviderAddPage />);
  const tuzi = screen.getByRole('button', { name: /Tuzi/ });
  await waitFor(() => expect(within(tuzi).getByText('已添加')).toBeInTheDocument());
  expect(within(screen.getByRole('button', { name: /OpenAI-HK/ })).queryByText('已添加')).not.toBeInTheDocument();
});
describe('路由成员', () => {
  it('显示欠费时间与全部欠费，恢复后移除状态', async () => {
    render(<ModelRoutesSection reloadToken={0} />);
    expect(await screen.findByText('全部成员欠费')).toBeInTheDocument();
    expect(screen.getByText(/欠费已摘除/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(gateway.restoreGatewayMember).toHaveBeenCalledWith('image', 'A'));
    await waitFor(() => expect(screen.queryByText('全部成员欠费')).not.toBeInTheDocument());
  });
});

beforeEach(() => { vi.mocked(keys.patchKey).mockReset().mockResolvedValue(undefined); });
it('按名称、类型和域名过滤供应商', async () => {
  render(<KeysPage embedded />);
  await screen.findByText('local');
  const search = screen.getByRole('textbox', { name: '查找供应商' });
  for (const query of ['LOCAL', '自定义', 'models.example.com']) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('listitem')).toHaveTextContent('local');
  }
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByText('没有匹配的供应商')).toBeInTheDocument();
});
it('停用立即变淡并提交，失败回滚且列表仍可操作', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(keys.patchKey).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render(<KeysPage embedded />);
  const toggle = await screen.findByRole('switch', { name: '启用 local' });
  fireEvent.click(toggle);
  expect(screen.getByText('已停用').closest('li')).toHaveClass('opacity-50');
  expect(toggle).toBeDisabled();
  expect(keys.patchKey).toHaveBeenCalledWith('local', { enabled: false });
  reject(new Error('保存失败'));
  await screen.findByText('保存失败');
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(toggle).toBeEnabled();
  expect(screen.queryByText('已停用')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toHaveAttribute('aria-checked', 'false');
});

it('状态优先级为停用、欠费、长期未用，30 天以内正常', () => {
  const row = { alias: 'old', provider: 'custom', masked_secret: '***',
    last_used_at: new Date(Date.now() - 31 * 86400000).toISOString() };
  const props = { pending: false, onEdit: vi.fn(), onToggle: vi.fn() };
  const view = render(<ProviderRow row={row} overdue={false} {...props} />);
  expect(screen.getByText('31 天未用')).toBeInTheDocument();
  view.rerender(<ProviderRow row={row} overdue {...props} />);
  expect(screen.getByText('欠费')).toBeInTheDocument();
  view.rerender(<ProviderRow row={{ ...row, enabled: false }} overdue {...props} />);
  expect(screen.getByText('已停用')).toBeInTheDocument();
  view.rerender(<ProviderRow row={{ ...row, last_used_at: new Date(Date.now() - 29 * 86400000).toISOString() }} overdue={false} {...props} />);
  expect(screen.getByText('正常')).toBeInTheDocument();
});
