import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { chooseOption } from '@/test/select';
import { describe, expect, it, vi } from 'vitest';
import { createKey } from '@/api/keys';
import { checkGateway } from '@/api/gateway';
import { KeyForm } from './KeyForm';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  createKey: vi.fn(),
}));
vi.mock('@/api/gateway', () => ({ checkGateway: vi.fn() }));

const via = [{ alias: 'HK', provider: 'custom', base_url: 'https://api.openai-hk.com/v1', model_id: 'gpt-image-2', name: 'gpt-image-2', protocol: null }];

describe('团队网关供应商', () => {
  it('连接网关后带回模型（含 via），保存时原样提交', async () => {
    vi.mocked(checkGateway).mockResolvedValue({
      info: { name: '美术组', version: '5.99.0', protocol: 2 },
      models: [{ id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image', via }],
    });
    vi.mocked(createKey).mockResolvedValue({ alias: '美术组网关' });
    render(<KeyForm onCreated={vi.fn()} onCancel={vi.fn()} />);

    await chooseOption(screen.getByLabelText('供应商选择'), /^团队网关/);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '美术组网关' } });
    fireEvent.change(screen.getByLabelText('网关地址'), { target: { value: 'http://192.168.1.20:5180' } });
    fireEvent.change(screen.getByLabelText('网关密钥'), { target: { value: 'atg_x' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();

    // 地址和密钥都齐了自动连接，不用再点按钮。
    await waitFor(() => expect(checkGateway).toHaveBeenCalledWith({ base_url: 'http://192.168.1.20:5180', access_key: 'atg_x' }));
    expect(await screen.findByText('美术组 · 5.99.0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(createKey).toHaveBeenCalledOnce());
    expect(vi.mocked(createKey).mock.calls[0][0]).toMatchObject({
      alias: '美术组网关', provider: 'atelier', base_url: 'http://192.168.1.20:5180', access_key: 'atg_x',
      modalities: ['image'], models: [{ id: 'gpt-image-2', via }],
    });
  });

  it('连上网关但这把密钥没有可用模型：说清原因，保存仍禁用（第 7 批）', async () => {
    vi.mocked(checkGateway).mockResolvedValue({ info: { name: '美术组', version: '5.99.0', protocol: 2 }, models: [] });
    render(<KeyForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    await chooseOption(screen.getByLabelText('供应商选择'), /^团队网关/);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '美术组网关' } });
    fireEvent.change(screen.getByLabelText('网关地址'), { target: { value: 'http://192.168.1.20:5180' } });
    fireEvent.change(screen.getByLabelText('网关密钥'), { target: { value: 'atg_x' } });
    // 原因写在禁用的保存按钮旁，一行短文案。
    const reason = await screen.findByText('这把密钥当前没有可用模型');
    expect(reason.closest('footer')).toContainElement(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
