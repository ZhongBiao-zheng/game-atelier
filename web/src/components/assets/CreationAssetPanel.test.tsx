import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CreationAsset } from '@/schema/creationAssets';
import { CreationAssetPanel } from './CreationAssetPanel';

const promptAsset: CreationAsset = {
  asset_id: 'asset-prompt',
  kind: 'prompt',
  title: '火山口三头犬',
  tags: ['角色', '概念图'],
  created_at: '2026-08-29T00:00:00Z',
  updated_at: '2026-08-29T00:00:00Z',
  last_used_at: null,
  archived_at: null,
  latest_version_id: 'version-1',
  project_ids: [],
  versions: [{
    kind: 'prompt',
    version_id: 'version-1',
    created_at: '2026-08-29T00:00:00Z',
    segments: [
      { kind: 'text', text: '一只' },
      { kind: 'variable', name: '主体', default_value: '白色三头犬' },
      { kind: 'text', text: '站在火山口。' },
    ],
  }],
};

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markUsed: vi.fn(),
  createPrompt: vi.fn(),
  removeFromProject: vi.fn(),
}));

vi.mock('@/api/creationAssets', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/creationAssets')>();
  return {
    ...actual,
    listCreationAssets: mocks.list,
    markCreationAssetUsed: mocks.markUsed,
    createPromptCreationAsset: mocks.createPrompt,
    removeCreationAssetFromProject: mocks.removeFromProject,
  };
});

describe('CreationAssetPanel', () => {
  it('uses prompt defaults in one step and closes the panel', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset], recent_tags: ['角色'] });
    mocks.markUsed.mockResolvedValue(promptAsset);
    const onUsePrompt = vi.fn();
    const onClose = vi.fn();
    render(
      <CreationAssetPanel
        onClose={onClose}
        onUsePrompt={onUsePrompt}
        onUseImage={vi.fn()}
      />,
    );

    expect(await screen.findByText('火山口三头犬')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => expect(onUsePrompt).toHaveBeenCalledWith(
      promptAsset,
      '一只白色三头犬站在火山口。',
      {},
      'replace',
    ));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shares values between variables with the same name', async () => {
    const repeated: CreationAsset = {
      ...promptAsset,
      versions: [{
        ...promptAsset.versions[0],
        kind: 'prompt',
        segments: [
          { kind: 'variable', name: '主体', default_value: '白犬' },
          { kind: 'text', text: '看向' },
          { kind: 'variable', name: '主体', default_value: '白犬' },
        ],
      }],
    };
    mocks.list.mockResolvedValue({ revision: 1, assets: [repeated], recent_tags: [] });
    mocks.markUsed.mockResolvedValue(repeated);
    const onUsePrompt = vi.fn();
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={onUsePrompt} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByText('火山口三头犬'));
    const input = screen.getByPlaceholderText('白犬');
    fireEvent.change(input, { target: { value: '黑猫' } });
    fireEvent.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => expect(onUsePrompt).toHaveBeenCalledWith(
      repeated,
      '黑猫看向黑猫',
      { 主体: '黑猫' },
      'replace',
    ));
  });

  it('warns about an identical prompt but still allows an explicit duplicate save', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset], recent_tags: [] });
    mocks.createPrompt.mockResolvedValue({ ...promptAsset, asset_id: 'asset-copy' });
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '新建提示词资产' }));
    fireEvent.change(screen.getByPlaceholderText('给这条提示词起个名字'), { target: { value: '副本' } });
    fireEvent.change(screen.getByPlaceholderText('输入可复用的提示词正文'), {
      target: { value: '一只白色三头犬站在火山口。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存提示词资产' }));

    expect(await screen.findByText(/提示词正文与“火山口三头犬”相同/)).toBeInTheDocument();
    expect(mocks.createPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '仍然保存' }));
    await waitFor(() => expect(mocks.createPrompt).toHaveBeenCalledOnce());
  });

  it('turns an entered tag into a capsule and saves it explicitly', async () => {
    const saved = { ...promptAsset, asset_id: 'asset-tagged', tags: ['角色'] };
    mocks.list.mockResolvedValue({ revision: 1, assets: [], recent_tags: [] });
    mocks.createPrompt.mockResolvedValue(saved);
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseImage={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '新建提示词资产' }));
    fireEvent.change(screen.getByPlaceholderText('给这条提示词起个名字'), { target: { value: '角色模板' } });
    fireEvent.change(screen.getByPlaceholderText('输入可复用的提示词正文'), { target: { value: '一只白犬' } });
    const tagInput = screen.getByPlaceholderText('输入标签，按 Enter 添加');
    fireEvent.change(tagInput, { target: { value: '角色' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    expect(screen.getByText('角色')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存提示词资产' }));

    await waitFor(() => expect(mocks.createPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      title: '角色模板',
      tags: ['角色'],
    })));
  });

  it('saves in Studio and then explicitly relates the asset to one selected canvas', async () => {
    const saved = { ...promptAsset, asset_id: 'asset-new', title: '新资产' };
    mocks.list.mockResolvedValue({ revision: 1, assets: [], recent_tags: [] });
    mocks.createPrompt.mockResolvedValue(saved);
    mocks.markUsed.mockResolvedValue({ ...saved, project_ids: ['canvas-one'] });
    render(
      <CreationAssetPanel
        saveRequest={{
          requestId: 'save-one',
          kind: 'prompt',
          title: '新资产',
          segments: [{ kind: 'text', text: '新的提示词' }],
        }}
        canvasTargets={[{ projectId: 'canvas-one', name: '角色草图' }]}
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseImage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '保存并加入画布' }));
    fireEvent.click(await screen.findByRole('button', { name: /角色草图/ }));

    await waitFor(() => expect(mocks.markUsed).toHaveBeenCalledWith('asset-new', 'canvas-one'));
    expect(await screen.findByRole('link', { name: /打开画布/ })).toHaveAttribute('href', '/canvas/canvas-one');
  });

  it('removes only the current project relation', async () => {
    const projectAsset = { ...promptAsset, project_ids: ['canvas-one'] };
    mocks.list.mockResolvedValue({ revision: 1, assets: [projectAsset], recent_tags: [] });
    mocks.removeFromProject.mockResolvedValue({ ...projectAsset, project_ids: [] });
    render(
      <CreationAssetPanel
        projectId="canvas-one"
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseImage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('火山口三头犬'));
    fireEvent.click(screen.getByRole('button', { name: '移出本项目' }));
    await waitFor(() => expect(mocks.removeFromProject).toHaveBeenCalledWith('asset-prompt', 'canvas-one'));
  });

  it('shows a newer-version notice and updates only after an explicit choice', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset], recent_tags: [] });
    const onUpdateReference = vi.fn().mockResolvedValue(undefined);
    render(
      <CreationAssetPanel
        projectId="canvas-one"
        activeReference={{ assetId: 'asset-prompt', versionId: 'version-old' }}
        onUpdateReference={onUpdateReference}
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseImage={vi.fn()}
      />,
    );

    expect(await screen.findByText('有新版本')).toBeInTheDocument();
    expect(onUpdateReference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('火山口三头犬'));
    fireEvent.click(screen.getByRole('button', { name: '更新本画布全部' }));
    await waitFor(() => expect(onUpdateReference).toHaveBeenCalledWith(promptAsset, 'all'));
  });
});
