import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GatewayKey, GatewayOptions } from '@/api/gateway';
import { KeyRowActions } from './KeyRowActions';

const options: GatewayOptions = {
  providers: [{ alias: 'HK', provider: 'custom', enabled: true, models: [
    { id: 'gpt-image-2', name: 'GPT Image', modality: 'image', route_id: 'gpt-image-2' },
    { id: 'm1', name: '演示图片', modality: 'image', route_id: 'declarative:hp-aaaaaaaaaaaa:m1' },
  ] }],
};

function key(overrides: Partial<GatewayKey>): GatewayKey {
  return {
    id: 'k1', name: '小王', role: 'member', quota: null, scope: [{ alias: 'HK', models: ['gpt-image-2'] }],
    created_at: '', revoked_at: null, quota_status: null, month_charged_cny: 0, month_calls: 0,
    last_used_at: null, ...overrides,
  } as GatewayKey;
}

function openModels(record: GatewayKey) {
  render(<KeyRowActions record={record} options={options} busy={false} onSave={vi.fn().mockResolvedValue(true)}
    onRename={vi.fn()} onReset={vi.fn()} onRevoke={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /个模型|全部模型/ }));
}

describe('网关密钥的模型权限', () => {
  it('设了金额上限时未计价的模型照常可勾选', () => {
    openModels(key({ quota: { period: 'day', cap_cny: 5 } }));
    const row = screen.getByText('演示图片').closest('label')!;
    expect(row).not.toHaveTextContent('不可用');
    expect(row.querySelector('button[role="checkbox"]')).not.toBeDisabled();
  });

  it('全部模型模式下不再提示未计价的模型不可用', () => {
    openModels(key({ quota: { period: 'day', cap_cny: 5 }, scope: null }));
    expect(screen.queryByText('未计价的模型该密钥不可用')).not.toBeInTheDocument();
  });
});
