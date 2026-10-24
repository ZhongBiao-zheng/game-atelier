import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('局域网 Atelier 供应商', () => {
  it('连接网关后带回模型（含 via），保存时原样提交', async () => {
    vi.mocked(checkGateway).mockResolvedValue({
      info: { name: '美术组', version: '5.99.0', protocol: 2 },
      models: [{ id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image', via }],
    });
    vi.mocked(createKey).mockResolvedValue({ alias: '美术组网关' });
    render(<KeyForm onCreated={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '局域网 Atelier 局域网' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '美术组网关' } });
    fireEvent.change(screen.getByLabelText('网关地址'), { target: { value: 'http://192.168.1.20:5180' } });
    fireEvent.change(screen.getByLabelText('网关密钥'), { target: { value: 'atg_x' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '连接网关' }));
    await waitFor(() => expect(checkGateway).toHaveBeenCalledWith({ base_url: 'http://192.168.1.20:5180', access_key: 'atg_x' }));
    expect(await screen.findByText('美术组 · 5.99.0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(createKey).toHaveBeenCalledOnce());
    expect(vi.mocked(createKey).mock.calls[0][0]).toMatchObject({
      alias: '美术组网关', provider: 'atelier', base_url: 'http://192.168.1.20:5180', access_key: 'atg_x',
      modalities: ['image'], models: [{ id: 'gpt-image-2', via }],
    });
  });
});
