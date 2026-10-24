import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as api from '@/api/gateway';
import { LanSharingSection } from './LanSharingSection';
vi.mock('@/hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('@/api/gateway', () => ({ fetchGateway: vi.fn(), fetchGatewayOptions: vi.fn(),
  fetchGatewayTasks: vi.fn(), fetchGatewayMembers: vi.fn(), createGatewayKey: vi.fn(), updateGatewayKey: vi.fn(),
  revokeGatewayKey: vi.fn(), updateGateway: vi.fn(), gatewayOutputUrl: vi.fn() }));
const key: api.GatewayKey = { id: 'k1', name: '小王', limits: [], allowed_models: null, allowed_aliases: null,
  created_at: '', revoked_at: null, month_charged_cny: .5, month_calls: 1, last_used_at: null, limits_status: [] };
const state: api.GatewayState = { enabled: true, port: 5180, name: '', default_name: 'mac', keys: [key], status: { running: true, port: 5180, error: null, addresses: ['192.168.1.20'] } };
beforeEach(() => { vi.clearAllMocks();
  vi.mocked(api.fetchGateway).mockResolvedValue(state);
  vi.mocked(api.fetchGatewayOptions).mockResolvedValue({ models: [{ id: 'gpt', name: 'GPT', modality: 'image' }], aliases: [{ alias: 'HK', name: 'HK', provider: 'custom' }] });
  vi.mocked(api.fetchGatewayTasks).mockResolvedValue([]);
  vi.mocked(api.fetchGatewayMembers).mockResolvedValue({ members: [], unavailable_routes: [] });
});
describe('LAN sharing', () => {
  it('creates all three limits and scoped permissions; plaintext disappears when closed', async () => {
    vi.mocked(api.createGatewayKey).mockResolvedValue({ key, token: 'atg_once' });
    render(<LanSharingSection />);
    await screen.findByText('http://192.168.1.20:5180');
    fireEvent.click(screen.getByRole('button', { name: '新建密钥' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '小李' } });
    for (const [label, value] of [['今日', '10'], ['本周', '50'], ['本月', '100']]) fireEvent.change(screen.getByLabelText(`${label}限额`), { target: { value } });
    fireEvent.click(screen.getByRole('switch', { name: '全部模型' })); fireEvent.click(screen.getByLabelText('GPT'));
    fireEvent.click(screen.getByRole('switch', { name: '全部供应商' })); fireEvent.click(screen.getByLabelText('HK'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.createGatewayKey).toHaveBeenCalledWith({ name: '小李', limits: [{ period: 'day', cap_cny: 10 }, { period: 'week', cap_cny: 50 }, { period: 'month', cap_cny: 100 }], allowed_models: ['gpt'], allowed_aliases: ['HK'] }));
    await screen.findByText('atg_once'); fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText('atg_once')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新建密钥' })); expect(screen.queryByText('atg_once')).not.toBeInTheDocument();
  });
  it('edits existing keys and revokes through confirmation', async () => {
    vi.mocked(api.updateGatewayKey).mockResolvedValue(key); vi.mocked(api.revokeGatewayKey).mockResolvedValue(key);
    render(<LanSharingSection />); fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改名' } }); fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.updateGatewayKey).toHaveBeenCalledWith('k1', expect.objectContaining({ name: '改名' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(api.revokeGatewayKey).toHaveBeenCalledWith('k1'));
  });
});

it('网关只保留密钥和运行中任务，花费链接定位团队成员', async () => {
  render(<LanSharingSection />);
  const link = await screen.findByRole('link', { name: '¥ 0.5' });
  expect(link).toHaveAttribute('href', '/settings/usage?scope=team&member=k1');
  expect(screen.queryByRole('region', { name: '供应商状态' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '用量' })).not.toBeInTheDocument();
});
it('网关关闭时隐藏密钥和端口', async () => {
  vi.mocked(api.fetchGateway).mockResolvedValue({ ...state, enabled: false });
  render(<LanSharingSection />);
  await waitFor(() => expect(screen.getByRole('switch', { name: '开启局域网共享' })).not.toBeDisabled());
  expect(screen.queryByRole('button', { name: '新建密钥' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('端口')).not.toBeInTheDocument();
});
