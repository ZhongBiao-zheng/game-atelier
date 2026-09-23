import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { creationAssetMediaUrl } from '@/api/creationAssets';
import type { CreationAsset } from '@/schema/creationAssets';
import { promptFromAsset } from '@/lib/promptVariables';
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

const generationAsset: CreationAsset = {
  ...promptAsset,
  asset_id: 'asset-generation',
  kind: 'generation',
  title: '雪山白犬',
  tags: [],
  content: {
    kind: 'generation',
    media: {
      kind: 'media',
      path: 'creation-assets/blobs/dog.png',
      mime_type: 'image/png',
      bytes: 3,
      sha256: 'b'.repeat(64),
      filename: 'white-dog.png',
    },
    snapshot: {
      mode: 'image',
      model: 'gpt-image-2',
      provider: 'openai-hk',
      alias: 'hk',
      final_prompt: '一只白犬站在雪山。',
      draft_prompt: null,
      params: { quality: 'high' },
      inputs: [],
      cost_cny: 0.3,
      cost_basis: 'actual',
      submitted_at: '2026-09-23T00:00:00Z',
    },
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

vi.mock('./TeamLibraryPanel', () => ({
  TeamLibraryPanel: ({ projectId, onOpenSettings, onReproduce }: {
    projectId: string;
    onOpenSettings?: () => void;
    onReproduce?: (asset: CreationAsset) => void;
  }) => (
    <div data-testid="team-panel" data-project-id={projectId}>
      {onOpenSettings && <button type="button" onClick={onOpenSettings}>挂载</button>}
      {onReproduce && <button type="button" onClick={() => onReproduce(generationAsset)}>团队复刻</button>}
    </div>
  ),
}));

describe('CreationAssetPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('inserts an unfilled inline template in one step and closes', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    mocks.markUsed.mockResolvedValue(promptAsset);
    const onUsePrompt = vi.fn();
    const onClose = vi.fn();
    render(<CreationAssetPanel onClose={onClose} onUsePrompt={onUsePrompt} onUseMedia={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    expect(mocks.list.mock.calls[0][0]).toEqual(expect.objectContaining({ kind: 'prompt' }));
    fireEvent.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => expect(onUsePrompt).toHaveBeenCalledWith(
      promptAsset,
      promptFromAsset(promptAsset.content.kind === 'prompt' ? promptAsset.content.segments : []),
    ));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves repeated variables to be filled inside the prompt, not a separate form', async () => {
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
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={onUsePrompt} onUseMedia={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    expect(screen.queryByPlaceholderText('白犬')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => expect(onUsePrompt).toHaveBeenCalledWith(
      repeated,
      promptFromAsset(repeated.content.kind === 'prompt' ? repeated.content.segments : []),
    ));
  });

  it('warns about an identical prompt but still allows an explicit duplicate save', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    mocks.createPrompt.mockResolvedValue({ ...promptAsset, asset_id: 'asset-copy' });
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

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
    render(<CreationAssetPanel projectId="canvas-demo-1234" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

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
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

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

  it('has no recommendation fields in the prompt editor', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    mocks.updatePrompt.mockResolvedValue(promptAsset);
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.queryByText('推荐配置')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('推荐模型')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(mocks.updatePrompt).toHaveBeenCalledOnce());
    expect(mocks.updatePrompt.mock.calls[0][1]).not.toHaveProperty('recommendation');
  });

  it('asks before discarding a dirty edit', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

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
    render(<CreationAssetPanel ref={panelRef} onClose={onClose} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

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
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /火山口三头犬/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '删除资产' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('删除后不可恢复');
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.deleteAsset).toHaveBeenCalledWith('asset-prompt'));
    expect(await screen.findByText('还没有提示词资产')).toBeInTheDocument();
  });

  it('opens the team library only when a project is in scope', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [] });
    render(
      <CreationAssetPanel
        projectId="proj-1"
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseMedia={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '团队' }));
    expect(await screen.findByTestId('team-panel')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('搜索标题、正文或标签')).not.toBeInTheDocument();
  });

  it('falls back to prompts when the project behind the team tab disappears', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    const view = render(
      <CreationAssetPanel
        projectId="proj-1"
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseMedia={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '团队' }));
    expect(await screen.findByTestId('team-panel')).toBeInTheDocument();

    view.rerender(
      <CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />,
    );

    expect(await screen.findByPlaceholderText('搜索标题、正文或标签')).toBeInTheDocument();
    expect(screen.queryByTestId('team-panel')).not.toBeInTheDocument();
  });

  it('lets Studio pick a canvas project for the team tab without scoping personal assets', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [promptAsset] });
    render(
      <CreationAssetPanel
        canvasTargets={[{ projectId: 'canvas-a', name: '画布甲' }, { projectId: 'canvas-b', name: '画布乙' }]}
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseMedia={vi.fn()}
      />,
    );

    expect(await screen.findByPlaceholderText('搜索标题、正文或标签')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '资产范围' })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '团队' }));
    expect(await screen.findByTestId('team-panel')).toHaveAttribute('data-project-id', 'canvas-a');
    fireEvent.change(screen.getByLabelText('画布项目'), { target: { value: 'canvas-b' } });
    expect(await screen.findByTestId('team-panel')).toHaveAttribute('data-project-id', 'canvas-b');
  });

  it('hides the team tab without a project', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [] });
    render(<CreationAssetPanel onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

    await screen.findByRole('button', { name: '提示词' });
    expect(screen.queryByRole('button', { name: '团队' })).not.toBeInTheDocument();
  });

  it('passes the team canvas to the mount exit and hides it when no exit is given', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [] });
    const onOpenSettings = vi.fn();
    const view = render(
      <CreationAssetPanel
        projectId="canvas-a"
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseMedia={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '团队' }));
    fireEvent.click(await screen.findByRole('button', { name: '挂载' }));
    expect(onOpenSettings).toHaveBeenCalledWith('canvas-a');

    view.rerender(
      <CreationAssetPanel projectId="canvas-a" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />,
    );
    expect(await screen.findByTestId('team-panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '挂载' })).not.toBeInTheDocument();
  });

  it('previews video and audio media with native players', async () => {
    const media = {
      ...promptAsset,
      kind: 'media' as const,
      tags: [],
      content: {
        kind: 'media' as const,
        path: 'creation-assets/blobs/clip.mp4',
        mime_type: 'video/mp4',
        bytes: 3,
        sha256: 'a'.repeat(64),
        filename: 'clip.mp4',
      },
    };
    const video: CreationAsset = { ...media, asset_id: 'asset-video', title: '开场' };
    const audio: CreationAsset = {
      ...media,
      asset_id: 'asset-audio',
      title: '战鼓',
      content: { ...media.content, mime_type: 'audio/mpeg', filename: 'drum.mp3' },
    };
    mocks.list.mockResolvedValue({ revision: 1, assets: [video, audio] });
    const { container } = render(
      <CreationAssetPanel initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />,
    );

    await screen.findByRole('button', { name: /开场/ });
    const player = container.querySelector('video');
    expect(player).toHaveAttribute('src', creationAssetMediaUrl('asset-video'));
    expect(player?.muted).toBe(true);
    expect(container.querySelector('audio')).toHaveAttribute('src', creationAssetMediaUrl('asset-audio'));
    expect(container.querySelector('img')).toBeNull();
  });

  it('lists generation assets in the media tab and uses their finished media', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [generationAsset, promptAsset] });
    mocks.markUsed.mockResolvedValue(generationAsset);
    const onUseMedia = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <CreationAssetPanel initialKind="media" onClose={onClose} onUsePrompt={vi.fn()} onUseMedia={onUseMedia} />,
    );

    const card = await screen.findByRole('button', { name: /雪山白犬/ });
    // 生成资产只能在不按 kind 过滤的列表里拿到；改回 kind: 'media' 会把它们漏掉。
    expect(mocks.list.mock.calls[0][0]).toHaveProperty('kind', undefined);
    expect(screen.queryByRole('button', { name: /火山口三头犬/ })).not.toBeInTheDocument();
    expect(card).toHaveTextContent('white-dog.png');
    expect(container.querySelector('img')).toHaveAttribute('src', creationAssetMediaUrl('asset-generation'));

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: '雪山白犬' })).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', creationAssetMediaUrl('asset-generation'));
    fireEvent.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => expect(onUseMedia).toHaveBeenCalledWith(
      generationAsset,
      generationAsset.content.kind === 'generation' ? generationAsset.content.media : null,
    ));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('finds generation assets by their media filename', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [generationAsset] });
    render(<CreationAssetPanel initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

    await screen.findByRole('button', { name: /雪山白犬/ });
    fireEvent.change(screen.getByPlaceholderText('搜索标题、正文或标签'), { target: { value: 'white-dog' } });
    expect(screen.getByRole('button', { name: /雪山白犬/ })).toBeInTheDocument();
  });

  it('deletes a generation asset from its detail', async () => {
    mocks.list
      .mockResolvedValueOnce({ revision: 1, assets: [generationAsset] })
      .mockResolvedValue({ revision: 2, assets: [] });
    mocks.deleteAsset.mockResolvedValue(undefined);
    render(<CreationAssetPanel initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /雪山白犬/ }));
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除资产' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.deleteAsset).toHaveBeenCalledWith('asset-generation'));
  });

  it('passes onReproduce through to the team panel only when given', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [] });
    const onReproduce = vi.fn();
    const view = render(
      <CreationAssetPanel projectId="canvas-a" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} onReproduce={onReproduce} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '团队' }));
    fireEvent.click(await screen.findByRole('button', { name: '团队复刻' }));
    expect(onReproduce).toHaveBeenCalledWith(generationAsset);

    view.rerender(
      <CreationAssetPanel projectId="canvas-a" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />,
    );
    expect(await screen.findByTestId('team-panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '团队复刻' })).not.toBeInTheDocument();
  });

  it('reproduces a generation asset from its card and detail', async () => {
    const mediaAsset: CreationAsset = {
      ...promptAsset,
      asset_id: 'asset-media',
      kind: 'media',
      title: '普通图',
      tags: [],
      content: { kind: 'media', path: 'creation-assets/blobs/m.png', mime_type: 'image/png', bytes: 3, sha256: 'c'.repeat(64), filename: 'm.png' },
    };
    mocks.list.mockResolvedValue({ revision: 1, assets: [generationAsset, mediaAsset] });
    mocks.markUsed.mockResolvedValue(generationAsset);
    const onReproduce = vi.fn();
    const onClose = vi.fn();
    render(
      <CreationAssetPanel initialKind="media" onClose={onClose} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} onReproduce={onReproduce} />,
    );

    await screen.findByRole('button', { name: /普通图/ });
    const cardButtons = screen.getAllByRole('button', { name: '复刻' });
    expect(cardButtons).toHaveLength(1);
    fireEvent.click(cardButtons[0]);
    await waitFor(() => expect(onReproduce).toHaveBeenCalledWith(generationAsset));
    expect(mocks.markUsed).toHaveBeenCalledWith('asset-generation', undefined);
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /雪山白犬/ }));
    await screen.findByRole('heading', { name: '雪山白犬' });
    fireEvent.click(screen.getByRole('button', { name: '复刻' }));
    await waitFor(() => expect(onReproduce).toHaveBeenCalledTimes(2));
  });

  it('hides reproduce on generation assets without onReproduce', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [generationAsset] });
    render(<CreationAssetPanel initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /雪山白犬/ }));
    await screen.findByRole('heading', { name: '雪山白犬' });
    expect(screen.queryByRole('button', { name: '复刻' })).not.toBeInTheDocument();
  });
});
