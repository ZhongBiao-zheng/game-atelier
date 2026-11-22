import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createKey, patchKey, previewModels, type ModelsPreview } from '@/api/keys';
import { listHttpProtocols } from '@/api/httpProtocols';
import { KeyForm } from './KeyForm';

vi.mock('@/api/keys', async original => ({ ...await original<typeof import('@/api/keys')>(),
  createKey: vi.fn(), patchKey: vi.fn(), previewModels: vi.fn() }));
vi.mock('@/api/httpProtocols', async original => ({ ...await original<typeof import('@/api/httpProtocols')>(), listHttpProtocols: vi.fn() }));

const remote: ModelsPreview = { models: [
  { id: 'chat-demo', name: 'Chat', category: 'text', modality: 'text', protocol: 'openai-chat', input_modalities: ['text'] },
  { id: 'image-demo', name: 'Image', category: 'image', modality: 'image', protocol: 'openai', input_modalities: [] },
], total: 2, excluded: 0 };
const initial = { alias: 'vendor', provider: 'custom', base_url: 'http://127.0.0.1:9999/v1', access_key: 'test-only',
  models: [{ id: 'chat-demo', name: 'Chat', modality: 'text' as const, protocol: 'openai-chat' }] };
const open = (mode: 'create' | 'edit' = 'create') => render(<KeyForm presetId="custom" mode={mode} initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [] });
  vi.mocked(previewModels).mockResolvedValue(remote);
  vi.mocked(createKey).mockResolvedValue({ alias: 'vendor' });
  vi.mocked(patchKey).mockResolvedValue(undefined);
});

it('keeps selected chips pressed across search and category changes, and toggles them off', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  const chip = await screen.findByRole('button', { name: 'Chat chat-demo' });
  expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(chip).toHaveClass('aria-pressed:bg-primary/10', 'aria-pressed:text-foreground');
  expect(chip.querySelector('svg')).not.toBeNull();
  const image = screen.getByRole('button', { name: 'Image image-demo' });
  expect(image).toHaveAttribute('aria-pressed', 'false');
  expect(image.querySelector('svg')).toBeNull();
  fireEvent.click(image);
  fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: 'chat' } });
  expect(screen.queryByRole('button', { name: 'Image image-demo' })).toBeNull();
  fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: '' } });
  const filters = within(screen.getByRole('radiogroup', { name: '模型类型筛选' }));
  fireEvent.click(filters.getByRole('radio', { name: '图片 1' }));
  expect(screen.getByRole('button', { name: 'Image image-demo' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(filters.getByRole('radio', { name: '全部 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Chat chat-demo' }));
  expect(screen.getByRole('button', { name: 'Chat chat-demo' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: '启用所选（1）' }));
  expect(screen.getByRole('button', { name: 'image-demo' })).toHaveClass('bg-primary/10');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalledWith(expect.objectContaining({ models: [expect.objectContaining({ id: 'image-demo' })] })));
});
