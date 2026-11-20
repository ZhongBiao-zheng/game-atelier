import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GatewayKey, GatewayOptions } from '@/api/gateway';
import { KeyScopePicker } from './KeyScopePicker';
import { scopeModelCount, toggleModel, toggleProvider } from './keyScope';

// 第 7 批：密钥范围按「供应商 → 它的模型」选。

const options: GatewayOptions = {
  providers: [
    { alias: 'HK', provider: 'custom', enabled: true, models: [
      { id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image', route_id: 'gpt-image-2' },
      { id: 'seedance', name: 'Seedance', modality: 'video', route_id: 'seedance:seedance' },
    ] },
    { alias: 'Tuzi', provider: 'custom', enabled: true, models: [
      { id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image', route_id: 'gpt-image-2' },
    ] },
    { alias: '旧账号', provider: 'custom', enabled: false, models: [
      { id: 'mj', name: 'Midjourney', modality: 'image', route_id: null },
    ] },
  ],
};

function key(overrides: Partial<GatewayKey> = {}): GatewayKey {
  return {
    id: 'k1', name: '小王', role: 'member', limits: [], scope: null, limits_status: [],
    created_at: '', revoked_at: null, month_charged_cny: 0, month_calls: 0, last_used_at: null, ...overrides,
  };
}

function openScope(record: GatewayKey, onSave = vi.fn().mockResolvedValue(true), opts = options) {
  render(<KeyScopePicker record={record} options={opts} busy={false} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: /个模型|全部模型|未选择模型|^模型$/ }));
  return onSave;
}

const close = (label: string) => fireEvent.keyDown(screen.getByLabelText(label), { key: 'Escape' });

describe('范围的数据操作', () => {
  it('勾供应商是它的全部模型，再点一次去掉；勾模型挂在它的供应商下', () => {
    expect(toggleProvider([], 'HK')).toEqual([{ alias: 'HK', models: null }]);
    expect(toggleProvider([{ alias: 'HK', models: null }], 'HK')).toEqual([]);
    expect(toggleProvider([{ alias: 'HK', models: ['x'] }], 'HK')).toEqual([{ alias: 'HK', models: null }]);
    expect(toggleModel([], 'HK', 'x')).toEqual([{ alias: 'HK', models: ['x'] }]);
    expect(toggleModel([{ alias: 'HK', models: ['x'] }], 'HK', 'x')).toEqual([]);
  });

  it('按钮计数：某供应商全部时按它当前的模型数算', () => {
    expect(scopeModelCount([{ alias: 'HK', models: null }, { alias: 'Tuzi', models: ['gpt-image-2'] }], options.providers!)).toBe(3);
  });
});

describe('成员行「模型」弹层', () => {
  it('关掉全部模型后按供应商分组；只勾一个模型保存成「供应商 + 模型」', async () => {
    const onSave = openScope(key());
    fireEvent.click(screen.getByRole('switch', { name: '全部模型' }));
    const hk = screen.getByRole('region', { name: 'HK' });
    expect(within(hk).getByText('GPT Image 2')).toBeInTheDocument();
    expect(within(hk).getByText('Seedance')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('region', { name: 'Tuzi' })).getAllByRole('checkbox')[1]);
    close('可用模型');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ scope: [{ alias: 'Tuzi', models: ['gpt-image-2'] }] }));
  });

  it('勾供应商的「全部」后组内模型显示已选且不能单独取消', () => {
    openScope(key({ scope: [{ alias: 'HK', models: null }] }));
    const hk = screen.getByRole('region', { name: 'HK' });
    expect(within(hk).getByRole('checkbox', { name: 'HK 的全部模型' })).toBeChecked();
    const [, first, second] = within(hk).getAllByRole('checkbox');
    expect(first).toBeChecked();
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    expect(screen.getByRole('button', { name: '2 个模型' })).toBeInTheDocument();
  });

  it('什么都没勾时提示且不保存、弹层不关', () => {
    const onSave = openScope(key());
    fireEvent.click(screen.getByRole('switch', { name: '全部模型' }));
    close('可用模型');
    expect(screen.getByRole('alert')).toHaveTextContent('至少选一个模型');
    expect(screen.getByLabelText('可用模型')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('旧数据转换出的空范围显示「未选择模型」；原样关上不报错也不保存', () => {
    const onSave = openScope(key({ scope: [] }));
    expect(screen.getByRole('button', { name: '未选择模型' })).toBeInTheDocument();
    close('可用模型');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('可用模型')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('停用的供应商灰显不能勾', () => {
    openScope(key({ scope: [{ alias: 'HK', models: null }] }));
    const old = screen.getByRole('region', { name: '旧账号' });
    expect(old).toHaveTextContent('已停用');
    expect(within(old).getByRole('checkbox', { name: '旧账号 的全部模型' })).toBeDisabled();
  });

  it('主机版本较旧（没有 providers）时只提示更新、不保存', () => {
    const onSave = openScope(key(), undefined, {});
    expect(screen.getByText('主机版本较旧，更新主机后才能设置')).toBeInTheDocument();
    close('可用模型');
    expect(onSave).not.toHaveBeenCalled();
  });
});
