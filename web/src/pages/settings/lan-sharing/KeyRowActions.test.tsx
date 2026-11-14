import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GatewayKey, GatewayOptions } from '@/api/gateway';
import { KeyRowActions } from './KeyRowActions';

const options: GatewayOptions = {
  models: [
    { id: 'gpt-image-2', name: 'GPT Image', modality: 'image' },
    { id: 'declarative:hp-aaaaaaaaaaaa:m1', name: '演示图片', modality: 'image', unpriced: true },
  ],
  aliases: [],
};

function key(overrides: Partial<GatewayKey>): GatewayKey {
  return {
    id: 'k1', name: '小王', role: 'member', limits: [], allowed_models: [], allowed_aliases: null,
    created_at: '', revoked_at: null, limits_status: [], month_charged_cny: 0, month_calls: 0,
    last_used_at: null, ...overrides,
  } as GatewayKey;
}

function openModels(record: GatewayKey) {
  render(<KeyRowActions record={record} options={options} busy={false} onSave={vi.fn().mockResolvedValue(true)}
    onRename={vi.fn()} onReset={vi.fn()} onRevoke={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /个模型|全部模型/ }));
}

describe('网关密钥的模型权限', () => {
  it('设了金额上限时未计价的模型标明不可用且不能勾选', () => {
    openModels(key({ limits: [{ period: 'day', cap_cny: 5 }] }));
    const row = screen.getByText('演示图片').closest('label')!;
    expect(row).toHaveTextContent('未计价，该密钥不可用');
    expect(row.querySelector('button[role="checkbox"]')).toBeDisabled();
    expect(screen.getByText('GPT Image').closest('label')!.querySelector('button[role="checkbox"]')).not.toBeDisabled();
  });

  it('没有金额上限时未计价的模型照常可选', () => {
    openModels(key({ limits: [] }));
    const row = screen.getByText('演示图片').closest('label')!;
    expect(row).not.toHaveTextContent('不可用');
    expect(row.querySelector('button[role="checkbox"]')).not.toBeDisabled();
  });

  it('全部模型模式下也提示未计价的模型不可用', () => {
    openModels(key({ limits: [{ period: 'day', cap_cny: 5 }], allowed_models: null }));
    expect(screen.getByText('未计价的模型该密钥不可用')).toBeInTheDocument();
  });
});
