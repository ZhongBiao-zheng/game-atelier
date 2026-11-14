import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createKey, previewModels } from '@/api/keys';
import { listHttpProtocols } from '@/api/httpProtocols';
import type { HttpProtocolRow } from '@/schema/httpProtocols';
import { chooseOption } from '@/test/select';
import { KeyForm } from './KeyForm';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  createKey: vi.fn(),
  previewModels: vi.fn(),
}));
vi.mock('@/api/httpProtocols', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/httpProtocols')>(),
  listHttpProtocols: vi.fn(),
}));

const row = (id: string, name: string, catalog: boolean): HttpProtocolRow => ({
  id, name, kind: 'image', available: true, error: null, declared: null, catalog, used_by: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [row('hp-aaaaaaaaaaaa', '画师接口', true), row('hp-bbbbbbbbbbbb', '无目录', false)] });
  vi.mocked(createKey).mockResolvedValue({ alias: 'vendor' });
});

const open = () => render(<KeyForm presetId="custom" initial={{ alias: 'vendor', base_url: 'https://example.com', access_key: 'sk', models: [] }} onCreated={vi.fn()} onCancel={vi.fn()} />);

it('discovers through a template catalog, warns, and binds rows of the template kind', async () => {
  vi.mocked(previewModels).mockResolvedValue({
    models: [
      { id: 'painter', name: 'Painter', modality: 'image', category: 'image', protocol: null, input_modalities: [] },
      { id: 'mystery', name: 'Mystery', modality: null, category: 'unknown', protocol: null, input_modalities: [] },
      { id: 'chat', name: 'Chat', modality: 'text', category: 'text', protocol: null, input_modalities: [] },
    ],
    total: 3, excluded: 0, discovered: true,
  });
  open();
  const source = await screen.findByLabelText('模型目录');
  await chooseOption(source, '画师接口');
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  expect(await screen.findByText('已发现不代表可用')).toBeInTheDocument();
  expect(previewModels).toHaveBeenCalledWith(expect.objectContaining({ protocol_id: 'hp-aaaaaaaaaaaa' }));
  for (const name of [/painter/, /mystery/, /chat/]) fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(screen.getByRole('radio', { name: '图片' }));  // 未识别行由用户指定分类
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalled());
  const models = vi.mocked(createKey).mock.calls[0][0].models ?? [];
  expect(models).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'painter', modality: 'image', protocol: 'declarative', declarative_id: 'hp-aaaaaaaaaaaa' }),
    expect.objectContaining({ id: 'mystery', modality: 'image', protocol: 'declarative', declarative_id: 'hp-aaaaaaaaaaaa' }),
  ]));
  const chat = models.find(model => model.id === 'chat');
  expect(chat).toMatchObject({ modality: 'text', protocol: null });
  expect(chat).not.toHaveProperty('declarative_id');
});

it('defaults to /models and hides the source picker when no template has a catalog', async () => {
  vi.mocked(previewModels).mockResolvedValue({ models: [], total: 0, excluded: 0 });
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [row('hp-bbbbbbbbbbbb', '无目录', false)] });
  open();
  await waitFor(() => expect(listHttpProtocols).toHaveBeenCalled());
  expect(screen.queryByLabelText('模型目录')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  await waitFor(() => expect(previewModels).toHaveBeenCalledWith(expect.objectContaining({ protocol_id: null })));
  expect(screen.queryByText('已发现不代表可用')).not.toBeInTheDocument();
});
