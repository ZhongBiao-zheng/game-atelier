import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KeysPage } from './Keys';
import { ModelRoutesSection } from './ModelRoutesSection';
import * as gateway from '@/api/gateway';
vi.mock('@/api/keys', async original => ({
  ...await original<typeof import('@/api/keys')>(),
  listKeys: async () => ({ keys: [
    { alias: 'local', provider: 'custom', access_key: '***', models: [] },
    { alias: 'lan', provider: 'atelier', access_key: '***', models: [] },
  ] }),
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
  const rows = screen.getAllByRole('row');
  expect(rows[1]).toHaveTextContent('lan');
  expect(rows[2]).toHaveTextContent('local');
  expect(screen.queryByLabelText('中转额度')).not.toBeInTheDocument();
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
