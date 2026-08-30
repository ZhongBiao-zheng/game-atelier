import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreationAsset } from '@/schema/creationAssets';
import {
  CreationAssetPanel,
  type CreationAssetPanelHandle,
} from './CreationAssetPanel';

const promptAsset: CreationAsset = {
  asset_id: 'asset-prompt',
  kind: 'prompt',
  title: '火山口三头犬',
  tags: ['角色', '概念图'],
  created_at: '2026-08-29T00:00:00Z',
  updated_at: '2026-08-29T00:00:00Z',
  last_used_at: null,
  project_ids: [],
  content: {
    kind: 'prompt',
    segments: [
      { kind: 'text', text: '一只' },
      { kind: 'variable', name: '主体', default_value: '白色三头犬' },
      { kind: 'text', text: '站在火山口。' },
    ],
  },
};

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markUsed: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deleteAsset: vi.fn(),
}));

vi.mock('@/api/creationAssets', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/creationAssets')>();
  return {
    ...actual,
    listCreationAssets: mocks.list,
    markCreationAssetUsed: mocks.markUsed,
    createPromptCreationAsset: mocks.createPrompt,
    updatePromptCreationAsset: mocks.updatePrompt,
    deleteCreationAsset: mocks.deleteAsset,
  };
});

describe('CreationAssetPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('opens card detail, uses prompt defaults in one step, and closes', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    mocks.markUsed.mockResolvedValue(promptAsset);
    const onUsePrompt = vi.fn();
    const onClose = vi.fn();
    render(<CreationAssetPanel onClose={onClose} onUsePrompt={onUsePrompt} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => expect(onUsePrompt).toHaveBeenCalledWith(
      promptAsset,
      '一只白色三头犬站在火山口。',
      {},
    ));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shares one input value between variables with the same name', async () => {
    const repeated: CreationAsset = {
      ...promptAsset,
      content: {
        kind: 'prompt',
        segments: [
          { kind: 'variable', name: '主体', default_value: '白犬' },
          { kind: 'text', text: '看向' },
          { kind: 'variable', name: '主体', default_value: '白犬' },
        ],
      },
    };
    mocks.list.mockResolvedValue({ revision: 1, assets: [repeated] });
    mocks.markUsed.mockResolvedValue(repeated);
    const onUsePrompt = vi.fn();
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={onUsePrompt} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.change(screen.getByPlaceholderText('白犬'), { target: { value: '黑猫' } });
    fireEvent.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => expect(onUsePrompt).toHaveBeenCalledWith(
      repeated,
      '黑猫看向黑猫',
      { 主体: '黑猫' },
    ));
  });

  it('warns about an identical prompt but still allows an explicit duplicate save', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    mocks.createPrompt.mockResolvedValue({ ...promptAsset, asset_id: 'asset-copy' });
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '新建提示词资产' }));
    fireEvent.change(screen.getByPlaceholderText('给这条提示词起个名字'), { target: { value: '副本' } });
    fireEvent.change(screen.getByPlaceholderText('输入可复用的提示词正文'), { target: { value: '一只白色三头犬站在火山口。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存提示词资产' }));

    expect(await screen.findByText(/提示词正文与“火山口三头犬”相同/)).toBeInTheDocument();
    expect(mocks.createPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '仍然保存' }));
    await waitFor(() => expect(mocks.createPrompt).toHaveBeenCalledOnce());
  });

  it('checks prompt duplicates against the global library from a project-scoped Canvas', async () => {
    mocks.list.mockImplementation(async options => (
      options.scope === 'all'
        ? { revision: 1, assets: [promptAsset] }
        : { revision: 1, assets: [] }
    ));
    render(<CreationAssetPanel projectId="canvas-demo-1234" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '新建提示词资产' }));
    fireEvent.change(screen.getByPlaceholderText('给这条提示词起个名字'), { target: { value: '项目内副本' } });
    fireEvent.change(screen.getByPlaceholderText('输入可复用的提示词正文'), { target: { value: '一只白色三头犬站在火山口。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存提示词资产' }));

    expect(await screen.findByText(/提示词正文与“火山口三头犬”相同/)).toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith({ kind: 'prompt', scope: 'all' });
  });

  it('edits the same asset in place and returns to its detail', async () => {
    const updated = { ...promptAsset, title: '新标题' };
    mocks.list
      .mockResolvedValueOnce({ revision: 1, assets: [promptAsset] })
      .mockResolvedValue({ revision: 2, assets: [updated] });
    mocks.updatePrompt.mockResolvedValue(updated);
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByDisplayValue('火山口三头犬'), { target: { value: '新标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(mocks.updatePrompt).toHaveBeenCalledWith(
      'asset-prompt',
      expect.objectContaining({ title: '新标题' }),
    ));
    expect(await screen.findByRole('heading', { name: '新标题' })).toBeInTheDocument();
  });

  it('asks before discarding a dirty edit', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByDisplayValue('火山口三头犬'), { target: { value: '改了一半' } });
    fireEvent.click(screen.getByRole('button', { name: '返回资产列表' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('放弃未保存的修改');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByDisplayValue('改了一半')).toBeInTheDocument();
  });

  it('also guards close requests from the parent trigger and keyboard shortcuts', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    const onClose = vi.fn();
    const panelRef = createRef<CreationAssetPanelHandle>();
    render(<CreationAssetPanel ref={panelRef} onClose={onClose} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByDisplayValue('火山口三头犬'), { target: { value: '外部关闭前未保存' } });
    act(() => panelRef.current?.requestClose());

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('放弃未保存的修改');
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('physically deletes only after the irreversible confirmation', async () => {
    mocks.list
      .mockResolvedValueOnce({ revision: 1, assets: [promptAsset] })
      .mockResolvedValue({ revision: 2, assets: [] });
    mocks.deleteAsset.mockResolvedValue(undefined);
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '删除资产' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('删除后不可恢复');
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.deleteAsset).toHaveBeenCalledWith('asset-prompt'));
    expect(await screen.findByText('还没有提示词资产')).toBeInTheDocument();
  });
});
