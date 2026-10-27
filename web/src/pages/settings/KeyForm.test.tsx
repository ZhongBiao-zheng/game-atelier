import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatGPTSubscription, createKey, patchKey, previewModels } from '@/api/keys';
import { KeyForm } from './KeyForm';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  getChatGPTSubscription: vi.fn(),
  createKey: vi.fn(),
  patchKey: vi.fn(),
  previewModels: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe('EvoLink key preset', () => {
  it('saves the normal V8.2 model and its protocol without derivative actions', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'evolink' });
    render(<KeyForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'evolink' } });
    expect(screen.getByLabelText('模型名称 1')).toHaveValue('Midjourney V8.2');
    expect(screen.getByLabelText('模型 ID 1')).toHaveValue('mj-v8.2');
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'test-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalledOnce());
    expect(vi.mocked(createKey).mock.calls[0][0]).toMatchObject({
      alias: 'evolink', provider: 'evolink', base_url: 'https://api.evolink.ai/v1',
      modalities: ['image'], models: [{ name: 'Midjourney V8.2', id: 'mj-v8.2', modality: 'image', protocol: 'evolink' }],
    });
  });
});


describe('供应商弹窗', () => {
  it('opens the Tuzi preset directly and saves its name and address', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'Tuzi' });
    render(<KeyForm presetId="tuzi" onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Tuzi');
    expect(screen.queryByLabelText('供应商选择')).not.toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue('Tuzi');
    expect(screen.getByLabelText('API 请求地址')).toHaveValue('https://api.tu-zi.com');
    expect(screen.getByRole('link', { name: '获取密钥 ↗' })).toHaveAttribute('href', 'https://api.tu-zi.com');
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'test-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalledWith(expect.objectContaining({
      alias: 'Tuzi', provider: 'custom', enabled: true, base_url: 'https://api.tu-zi.com',
    })));
  });

  it.each([false, true])('preserves or explicitly toggles disabled state (toggle=%s)', async toggle => {
    vi.mocked(patchKey).mockResolvedValue(undefined);
    render(<KeyForm mode="edit" initial={{ alias: 'custom-key', provider: 'custom',
      base_url: 'https://example.com', access_key: 'sk...mask', enabled: false, models: [] }}
      onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByLabelText('名称')).toHaveAttribute('readonly');
    if (toggle) fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalledWith('custom-key', expect.objectContaining({ enabled: toggle, models: [] })));
    expect(vi.mocked(patchKey).mock.calls[0][1]).not.toHaveProperty('access_key');
  });

  it('tests connectivity with the stored credential and leaves model selection unchanged', async () => {
    vi.mocked(previewModels).mockResolvedValue({ models: [{ id: 'remote', name: 'remote', modality: 'video', category: 'video', protocol: null, input_modalities: [] }], total: 1, excluded: 0 });
    vi.mocked(patchKey).mockResolvedValue(undefined);
    render(<KeyForm mode="edit" initial={{ alias: 'Tuzi', provider: 'custom', base_url: 'https://api.tu-zi.com', access_key: 'sk...mask',
      models: [{ id: 'gpt-image-2', name: 'My model', modality: 'image' }] }} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/可用 · \d+ ms/);
    expect(previewModels).toHaveBeenCalledWith(expect.objectContaining({ alias: 'Tuzi', access_key: null }));
    expect(screen.queryByRole('checkbox', { name: /remote/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalledWith('Tuzi', expect.objectContaining({ models: [expect.objectContaining({ id: 'gpt-image-2', name: 'My model' })] })));
  });

  it('shows a connection error without removing configured models', async () => {
    vi.mocked(previewModels).mockRejectedValue(new Error('密钥无效，请检查后重试'));
    render(<KeyForm presetId="tuzi" initial={{ access_key: 'test' }} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('密钥无效，请检查后重试');
    expect(screen.getByRole('button', { name: 'gpt-image-2' })).toBeInTheDocument();
  });

  it('submits checked preview tags directly and prevents unresolved classifications', async () => {
    vi.mocked(previewModels).mockResolvedValue({ models: [{ id: 'mystery', name: 'Mystery', modality: null, category: 'unknown', protocol: null, input_modalities: [] }], total: 1, excluded: 0 });
    vi.mocked(createKey).mockResolvedValue({ alias: 'test' });
    render(<KeyForm presetId="custom" initial={{ alias: 'test', base_url: 'https://example.com', access_key: 'test', models: [] }} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /mystery/ }));
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '视频' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalledWith(expect.objectContaining({ models: [expect.objectContaining({ id: 'mystery', modality: 'video' })] })));
  });

  it('supports Escape dismissal through the dialog', () => {
    const cancel = vi.fn();
    render(<KeyForm presetId="tuzi" onCreated={vi.fn()} onCancel={cancel} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});


it('keeps selected preview models when switching to the selected segment', async () => {
  vi.mocked(previewModels).mockResolvedValue({ models: [{ id: 'remote', name: 'Remote', modality: 'video', category: 'video', protocol: 'seedance', input_modalities: [] }], total: 1, excluded: 0 });
  vi.mocked(createKey).mockResolvedValue({ alias: 'test' });
  render(<KeyForm presetId="custom" initial={{ alias: 'test', base_url: 'https://example.com', access_key: 'test', models: [] }} onCreated={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /remote/ }));
  fireEvent.click(screen.getByRole('button', { name: '已选 1' }));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalledWith(expect.objectContaining({ models: [expect.objectContaining({ id: 'remote', modality: 'video' })] })));
});

it('restores stored classification and name when a removed tag is selected again', async () => {
  vi.mocked(previewModels).mockResolvedValue({ models: [{ id: 'stored', name: 'Upstream', modality: 'image', category: 'image', protocol: 'openai', input_modalities: [] }], total: 1, excluded: 0 });
  vi.mocked(patchKey).mockResolvedValue(undefined);
  render(<KeyForm mode="edit" initial={{ alias: 'test', provider: 'custom', base_url: 'https://example.com', access_key: 'masked',
    models: [{ id: 'stored', name: 'Custom name', modality: 'video' }] }} onCreated={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'stored' }));
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /stored/ }));
  fireEvent.click(screen.getByRole('button', { name: '已选 1' }));
  fireEvent.click(screen.getByText('模型详情'));
  expect(within(screen.getByLabelText('模型分类 1')).queryByRole('button')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(patchKey).toHaveBeenCalledWith('test', expect.objectContaining({ models: [expect.objectContaining({ id: 'stored', name: 'Custom name', modality: 'video', protocol: 'openai' })] })));
});

it('includes a manually added upstream model while the all segment is open', async () => {
  vi.mocked(previewModels).mockResolvedValue({ models: [{ id: 'remote', name: 'Remote', modality: 'video', category: 'video', protocol: 'seedance', input_modalities: [] }], total: 1, excluded: 0 });
  vi.mocked(createKey).mockResolvedValue({ alias: 'test' });
  render(<KeyForm presetId="custom" initial={{ alias: 'test', base_url: 'https://example.com', access_key: 'test', models: [] }} onCreated={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  await screen.findByRole('checkbox', { name: /remote/ });
  fireEvent.change(screen.getByLabelText('添加模型 ID'), { target: { value: 'remote' } });
  fireEvent.change(screen.getByLabelText('新增模型类型'), { target: { value: 'video' } });
  fireEvent.click(screen.getByRole('button', { name: '添加' }));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalledWith(expect.objectContaining({ models: [expect.objectContaining({ id: 'remote', modality: 'video' })] })));
});


describe('ChatGPT subscription', () => {
  it('shows the local account and saves only the fixed model and auth source', async () => {
    vi.mocked(getChatGPTSubscription).mockResolvedValue({ available: true, email: 'artist@example.test', plan: 'plus' });
    vi.mocked(createKey).mockResolvedValue({ alias: 'chatgpt' });
    render(<KeyForm presetId="chatgpt" onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText('artist@example.test')).toBeInTheDocument();
    expect(screen.getByText('plus')).toBeInTheDocument();
    expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API 请求地址')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加模型' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'chatgpt', auth_source: 'codex-cli', access_key: '', base_url: null,
      models: [{ id: 'gpt-image-2', name: 'GPT Image', modality: 'image', protocol: null, input_modalities: [] }],
    })));
  });

  it('requires Codex login before adding the subscription', async () => {
    vi.mocked(getChatGPTSubscription).mockResolvedValue({ available: false, email: null, plan: null });
    render(<KeyForm presetId="chatgpt" onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText('请先在 Codex 里用 ChatGPT 登录')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});


it('can disable an existing subscription even after Codex logout', async () => {
  vi.mocked(getChatGPTSubscription).mockResolvedValue({ available: false, email: null, plan: null });
  vi.mocked(patchKey).mockResolvedValue(undefined);
  render(<KeyForm mode="edit" initial={{ alias: 'chatgpt', provider: 'chatgpt', auth_source: 'codex-cli', access_key: '', models: [{ id: 'gpt-image-2', name: 'GPT Image', modality: 'image' }] }} onCreated={vi.fn()} onCancel={vi.fn()} />);
  expect(await screen.findByText('请先在 Codex 里用 ChatGPT 登录')).toBeInTheDocument();
  expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(patchKey).toHaveBeenCalledWith('chatgpt', expect.objectContaining({ enabled: false })));
});
