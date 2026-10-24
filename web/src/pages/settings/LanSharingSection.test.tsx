import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  createGatewayKey, fetchGateway, fetchGatewayUsage, revokeGatewayKey, updateGateway,
  type GatewayState,
} from '@/api/gateway';
import { LanSharingSection, summarizeUsage } from './LanSharingSection';

vi.mock('@/api/gateway', () => ({
  fetchGateway: vi.fn(), fetchGatewayUsage: vi.fn(), updateGateway: vi.fn(),
  createGatewayKey: vi.fn(), revokeGatewayKey: vi.fn(), updateGatewayKey: vi.fn(),
}));

const state = (patch: Partial<GatewayState> = {}): GatewayState => ({
  enabled: true, port: 5180, name: '', default_name: 'mac',
  keys: [{ id: 'k1', name: '小王', limits: [{ period: 'day', cap_cny: 50 }], allowed_models: null, allowed_aliases: null,
    created_at: '', revoked_at: null, month_charged_cny: 0.5, month_calls: 1, last_used_at: null,
    limits_status: [{ period: 'day', cap_cny: 50, used_cny: 3, reserved_cny: 0, left_cny: 47, resets_at: '' }] }],
  status: { running: true, port: 5180, error: null, addresses: ['192.168.1.20'] },
  ...patch,
});

describe('LanSharingSection', () => {
  it('显示地址与每人用量，新建密钥后只显示一次明文', async () => {
    vi.mocked(fetchGateway).mockResolvedValue(state());
    vi.mocked(fetchGatewayUsage).mockResolvedValue([{
      kind: 'image', estimated_cny: null, charged_cny: 0, input_tokens: null, output_tokens: null, duration: null, member_trail: [], time: '', key_id: 'k1', key_name: '小王', route_id: 'gpt-image-2', member_alias: 'HK',
      provider: 'custom', base_url: 'https://api.openai-hk.com/v1', model_id: 'gpt-image-2',
      n: 2, size: '1024x1024', quality: null, resolution: null, status: 'done', actual_cost_cny: 0.5,
    }]);
    vi.mocked(createGatewayKey).mockResolvedValue({ key: state().keys[0], token: 'atg_secret' });
    render(<LanSharingSection />);

    expect(await screen.findByText('http://192.168.1.20:5180')).toBeInTheDocument();
    expect(screen.getByText(/今日 ¥ 3 \/ ¥ 50 · 本月 2 张/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('使用人'), { target: { value: '小李' } });
    fireEvent.change(screen.getByLabelText('每日上限（元）'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '新建密钥' }));
    await waitFor(() => expect(createGatewayKey).toHaveBeenCalledWith({ name: '小李', limits: [{ period: 'day', cap_cny: 20 }], allowed_models: null, allowed_aliases: null }));
    expect(await screen.findByText('atg_secret')).toBeInTheDocument();
  });

  it('开关与撤销都要经过服务端', async () => {
    vi.mocked(fetchGateway).mockResolvedValue(state({ enabled: false, status: { running: false, port: null, error: null, addresses: [] } }));
    vi.mocked(fetchGatewayUsage).mockResolvedValue([]);
    vi.mocked(updateGateway).mockResolvedValue(state());
    vi.mocked(revokeGatewayKey).mockResolvedValue({ ...state().keys[0], revoked_at: 'now' });
    render(<LanSharingSection />);

    fireEvent.click(await screen.findByRole('switch', { name: '开启局域网共享' }));
    await waitFor(() => expect(updateGateway).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '开启局域网共享' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    const buttons = await screen.findAllByRole('button', { name: '撤销' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(revokeGatewayKey).toHaveBeenCalledWith('k1'));
  });

  it('只汇总服务端结算费用，并统计未计价调用', () => {
    const usage = summarizeUsage([
      { kind: 'image', estimated_cny: null, charged_cny: 0, input_tokens: null, output_tokens: null, duration: null, member_trail: [], time: '', key_id: 'k1', key_name: '小王', route_id: 'x', member_alias: 'A', provider: 'custom',
        base_url: 'https://example.com', model_id: 'unknown-model', n: 1, size: null, quality: null,
        resolution: null, status: 'done', actual_cost_cny: null },
      { kind: 'image', estimated_cny: null, charged_cny: 0, input_tokens: null, output_tokens: null, duration: null, member_trail: [], time: '', key_id: 'k1', key_name: '小王', route_id: 'x', member_alias: 'A', provider: 'custom',
        base_url: 'https://example.com', model_id: 'x', n: 0, size: null, quality: null,
        resolution: null, status: 'failed', actual_cost_cny: null },
    ]).get('k1');
    expect(usage).toEqual({ images: 1, failed: 1, cost: 0, unpriced: 2 });
  });
});
