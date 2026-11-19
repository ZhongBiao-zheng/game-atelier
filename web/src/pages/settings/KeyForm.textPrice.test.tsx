import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { patchKey } from '@/api/keys';
import { KeyForm } from './KeyForm';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  getChatGPTSubscription: vi.fn(),
  createKey: vi.fn(),
  patchKey: vi.fn(),
  previewModels: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

// 第 5 批 5-5：文本模型的手设单价按百万 token 填输入、输出两个价。
describe('未计价文本模型的单价', () => {
  const initial = {
    alias: 'Vendor', provider: 'custom' as const, base_url: 'https://api.example.com', access_key: 'sk...mask',
    models: [
      { id: 'chat', name: '对话模型', modality: 'text' as const, unpriced: true },
      { id: 'cheap', name: '未定价图片', modality: 'image' as const, unpriced: true },
    ],
  };

  it('文本行显示输入、输出两个框，图片行仍是按次单价', () => {
    render(<KeyForm mode="edit" initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('模型详情'));
    expect(screen.getByLabelText('输入单价 1')).toBeInTheDocument();
    expect(screen.getByLabelText('输出单价 1')).toBeInTheDocument();
    expect(screen.getByText('元/百万 token')).toBeInTheDocument();
    expect(screen.queryByLabelText('单价 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('单价 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('输入单价 2')).not.toBeInTheDocument();
  });

  it('保存文本行的输入、输出单价，不带按次单价', async () => {
    vi.mocked(patchKey).mockResolvedValue(undefined);
    render(<KeyForm mode="edit" initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('模型详情'));
    fireEvent.change(screen.getByLabelText('输入单价 1'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('输出单价 1'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalled());
    const [chat] = vi.mocked(patchKey).mock.calls[0][1].models!;
    expect(chat).toMatchObject({ id: 'chat', input_cny_per_m: 2, output_cny_per_m: 8 });
    expect(chat).not.toHaveProperty('per_call_cny');
    expect(chat).not.toHaveProperty('unpriced');
  });

  it('回显已存的文本单价，清空后不再提交', async () => {
    vi.mocked(patchKey).mockResolvedValue(undefined);
    render(<KeyForm mode="edit"
      initial={{ ...initial, models: [{ ...initial.models[0], input_cny_per_m: 1.5, output_cny_per_m: 6 }] }}
      onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('模型详情'));
    expect(screen.getByLabelText('输入单价 1')).toHaveValue('1.5');
    expect(screen.getByLabelText('输出单价 1')).toHaveValue('6');
    fireEvent.change(screen.getByLabelText('输入单价 1'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('输出单价 1'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalled());
    const [chat] = vi.mocked(patchKey).mock.calls[0][1].models!;
    expect(chat).not.toHaveProperty('input_cny_per_m');
    expect(chat).not.toHaveProperty('output_cny_per_m');
  });

  it('非法的文本单价不提交', () => {
    render(<KeyForm mode="edit" initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('模型详情'));
    fireEvent.change(screen.getByLabelText('输出单价 1'), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('单价请填 0 到 10000 之间的数字')).toBeInTheDocument();
    expect(patchKey).not.toHaveBeenCalled();
  });
});
