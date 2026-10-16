import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createKey } from '@/api/keys';
import { KeyForm } from './KeyForm';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  createKey: vi.fn(),
}));

describe('EvoLink key preset', () => {
  it('saves the normal V8.2 model and its protocol without derivative actions', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'evolink' });
    render(<KeyForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'EvoLink 第三方' }));
    expect(screen.getByLabelText('模型名称 1')).toHaveValue('Midjourney V8.2');
    expect(screen.getByLabelText('模型 ID 1')).toHaveValue('mj-v8.2');
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalledOnce());
    expect(vi.mocked(createKey).mock.calls[0][0]).toMatchObject({
      alias: 'evolink', provider: 'evolink', base_url: 'https://api.evolink.ai/v1',
      modalities: ['image'], models: [{ name: 'Midjourney V8.2', id: 'mj-v8.2', modality: 'image', protocol: 'evolink' }],
    });
  });
});
