import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamSourceWithdrawnError, creationAssetMediaUrl } from '@/api/creationAssets';
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

/** 面板里的媒体地址带内容版本（sha256 前 12 位）。 */
function versioned(assetId: string, sha256: string): string {
  return `${creationAssetMediaUrl(assetId)}?v=${sha256.slice(0, 12)}`;
}

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markUsed: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deleteAsset: vi.fn(),
  staleness: vi.fn(),
  readopt: vi.fn(),
  fromJob: vi.fn(),
  fromCanvas: vi.fn(),
  upload: vi.fn(),
  fromPath: vi.fn(),
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
    fetchCreationAssetStalenessBatch: mocks.staleness,
    readoptCreationAsset: mocks.readopt,
    saveGenerationFromJob: mocks.fromJob,
    saveGenerationFromCanvas: mocks.fromCanvas,
    uploadMediaCreationAsset: mocks.upload,
    saveMediaCreationAssetFromPath: mocks.fromPath,
  };
});

vi.mock('./TeamLibraryPanel', () => ({
  TeamLibraryPanel: ({ projectId, onOpenSettings, onReproduce, relatedSha256 }: {
    projectId: string;
    onOpenSettings?: () => void;
    onReproduce?: (asset: CreationAsset) => void;
    relatedSha256?: string | null;
  }) => (
    <div data-testid="team-panel" data-project-id={projectId} data-related-sha256={relatedSha256 ?? ''}>
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
    expect(player).toHaveAttribute('src', versioned('asset-video', 'a'.repeat(64)));
    expect(player?.muted).toBe(true);
    expect(container.querySelector('audio')).toHaveAttribute('src', versioned('asset-audio', 'a'.repeat(64)));
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
    expect(container.querySelector('img')).toHaveAttribute('src', versioned('asset-generation', 'b'.repeat(64)));

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: '雪山白犬' })).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', versioned('asset-generation', 'b'.repeat(64)));
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

  describe('adopted copies', () => {
    const origin = { library_id: 'lib_0123456789abcdef', source_updated_at: '2026-09-20T00:00:00Z', raw_path: null };
    const stale: CreationAsset = { ...generationAsset, asset_id: 'asset-stale', title: '旧白犬', adopted_from: { ...origin, asset_id: 'ta_stale' } };
    const gone: CreationAsset = { ...generationAsset, asset_id: 'asset-gone', title: '撤回的', adopted_from: { ...origin, asset_id: 'ta_gone' } };
    const fresh: CreationAsset = { ...generationAsset, asset_id: 'asset-fresh', title: '最新的', adopted_from: { ...origin, asset_id: 'ta_fresh' } };

    function renderMedia() {
      return render(<CreationAssetPanel initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);
    }

    function cardOf(title: string) {
      return screen.getByRole('button', { name: new RegExp(title) }).parentElement!;
    }

    it('checks staleness once in a batch for adopted assets only', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale, gone, fresh, generationAsset] });
      mocks.staleness.mockResolvedValue({ 'asset-stale': 'stale', 'asset-gone': 'withdrawn', 'asset-fresh': 'fresh' });
      renderMedia();

      expect(await screen.findByText('来源已更新')).toBeInTheDocument();
      expect(mocks.staleness).toHaveBeenCalledOnce();
      expect(mocks.staleness).toHaveBeenCalledWith(['asset-stale', 'asset-gone', 'asset-fresh']);
      expect(within(cardOf('旧白犬')).getByRole('button', { name: '重新采用' })).toBeInTheDocument();
      expect(within(cardOf('撤回的')).getByText('来源已撤回')).toBeInTheDocument();
      expect(within(cardOf('撤回的')).queryByRole('button', { name: '重新采用' })).toBeNull();
      expect(within(cardOf('最新的')).queryByText(/来源已/)).toBeNull();
      expect(screen.getAllByRole('button', { name: '重新采用' })).toHaveLength(1);

      fireEvent.change(screen.getByPlaceholderText('搜索标题、正文或标签'), { target: { value: '白犬' } });
      expect(screen.getByText('来源已更新')).toBeInTheDocument();
      expect(mocks.staleness).toHaveBeenCalledOnce();
    });

    it('skips the staleness check when nothing is adopted', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [generationAsset] });
      renderMedia();
      await screen.findByRole('button', { name: /雪山白犬/ });
      expect(mocks.staleness).not.toHaveBeenCalled();
    });

    it('readopts after confirmation and clears the badge', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale] });
      mocks.staleness.mockResolvedValue({ 'asset-stale': 'stale' });
      mocks.readopt.mockResolvedValue({ ...stale, title: '新白犬' });
      renderMedia();

      fireEvent.click(await screen.findByRole('button', { name: '重新采用' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: '覆盖本机副本？' })).toBeInTheDocument();
      expect(mocks.readopt).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: '覆盖' }));

      await waitFor(() => expect(mocks.readopt).toHaveBeenCalledWith('asset-stale'));
      expect(await screen.findByRole('button', { name: /新白犬/ })).toBeInTheDocument();
      expect(screen.queryByText('来源已更新')).toBeNull();
      expect(screen.queryByRole('button', { name: '重新采用' })).toBeNull();
    });

    it('turns the badge into withdrawn when the source was withdrawn meanwhile', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale] });
      mocks.staleness.mockResolvedValue({ 'asset-stale': 'stale' });
      mocks.readopt.mockRejectedValue(new TeamSourceWithdrawnError());
      renderMedia();

      fireEvent.click(await screen.findByRole('button', { name: '重新采用' }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '覆盖' }));

      expect(await screen.findByText('来源已撤回')).toBeInTheDocument();
      expect(screen.queryByText('来源已更新')).toBeNull();
      expect(screen.queryByRole('button', { name: '重新采用' })).toBeNull();
    });

    it('shows the badge and readopt in the detail too', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale] });
      mocks.staleness.mockResolvedValue({ 'asset-stale': 'stale' });
      renderMedia();

      await screen.findByText('来源已更新');
      fireEvent.click(screen.getByRole('button', { name: /旧白犬/ }));
      await screen.findByRole('heading', { name: '旧白犬' });
      expect(screen.getByText('来源已更新')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '重新采用' })).toBeInTheDocument();
    });

    it('shows the new media after readopt changes the content', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale] });
      mocks.staleness.mockResolvedValue({ 'asset-stale': 'stale' });
      const media = stale.content.kind === 'generation' ? stale.content.media : null;
      mocks.readopt.mockResolvedValue({
        ...stale,
        content: { ...stale.content, media: { ...media!, sha256: 'f'.repeat(64) } },
      });
      const { container } = renderMedia();

      await screen.findByText('来源已更新');
      expect(container.querySelector('img')).toHaveAttribute('src', versioned('asset-stale', 'b'.repeat(64)));
      fireEvent.click(screen.getByRole('button', { name: '重新采用' }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '覆盖' }));

      await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', versioned('asset-stale', 'f'.repeat(64))));
    });

    it('ignores a late staleness batch from an older refresh', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale] });
      let releaseFirst: (value: unknown) => void = () => {};
      mocks.staleness
        .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
        .mockResolvedValue({ 'asset-stale': 'fresh' });
      render(<CreationAssetPanel projectId="canvas-a" initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

      await screen.findByRole('button', { name: /旧白犬/ });
      fireEvent.click(screen.getByRole('button', { name: '全部资产' }));
      await waitFor(() => expect(mocks.staleness).toHaveBeenCalledTimes(2));
      await act(async () => { releaseFirst({ 'asset-stale': 'stale' }); });

      expect(screen.queryByText('来源已更新')).toBeNull();
    });

    it('keeps a readopted copy fresh when an older batch returns afterwards', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale] });
      let releaseSecond: (value: unknown) => void = () => {};
      mocks.staleness
        .mockResolvedValueOnce({ 'asset-stale': 'stale' })
        .mockImplementationOnce(() => new Promise(resolve => { releaseSecond = resolve; }));
      mocks.readopt.mockResolvedValue(stale);
      render(<CreationAssetPanel projectId="canvas-a" initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

      await screen.findByText('来源已更新');
      fireEvent.click(screen.getByRole('button', { name: '全部资产' }));
      await waitFor(() => expect(mocks.staleness).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole('button', { name: '重新采用' }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '覆盖' }));
      await waitFor(() => expect(screen.queryByText('来源已更新')).toBeNull());

      await act(async () => { releaseSecond({ 'asset-stale': 'stale' }); });
      expect(screen.queryByText('来源已更新')).toBeNull();
    });

    it('notes a failed staleness check and keeps the list usable', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [stale] });
      mocks.staleness.mockRejectedValue(new Error('boom'));
      renderMedia();

      expect(await screen.findByText('来源状态读取失败')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /旧白犬/ })).toBeInTheDocument();
      expect(screen.queryByText('来源已更新')).toBeNull();
    });
  });

  describe('saving generation results', () => {
    it('saves a Studio result as a generation asset without file replacement', async () => {
      mocks.list
        .mockResolvedValueOnce({ revision: 1, assets: [] })
        .mockResolvedValue({ revision: 2, assets: [generationAsset] });
      mocks.fromJob.mockResolvedValue(generationAsset);
      render(
        <CreationAssetPanel
          saveRequest={{ requestId: 'r1', kind: 'media', title: '雪山白犬', previewUrl: '/api/raw/x.png', source: { kind: 'job_output', job_id: 'job-1', output_index: 2 } }}
          onClose={vi.fn()}
          onUsePrompt={vi.fn()}
          onUseMedia={vi.fn()}
        />,
      );

      await screen.findByDisplayValue('雪山白犬');
      expect(screen.getByRole('img', { name: '媒体资产预览' })).toHaveAttribute('src', '/api/raw/x.png');
      fireEvent.click(screen.getByRole('button', { name: '保存生成资产' }));

      await waitFor(() => expect(mocks.fromJob).toHaveBeenCalledWith({
        job_id: 'job-1',
        output_index: 2,
        title: '雪山白犬',
        tags: [],
        project_id: null,
      }));
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.fromPath).not.toHaveBeenCalled();
      expect(await screen.findByRole('heading', { name: '雪山白犬' })).toBeInTheDocument();
    });

    it('saves a canvas result as a generation asset', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [] });
      mocks.fromCanvas.mockResolvedValue(generationAsset);
      render(
        <CreationAssetPanel
          projectId="canvas-a"
          saveRequest={{ requestId: 'r2', kind: 'media', title: '节点结果', sourcePath: '/data/x.png', source: { kind: 'canvas_result', canvas_project_id: 'canvas-a', node_id: 'n1', version_id: 'v1' } }}
          onClose={vi.fn()}
          onUsePrompt={vi.fn()}
          onUseMedia={vi.fn()}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: '保存生成资产' }));
      await waitFor(() => expect(mocks.fromCanvas).toHaveBeenCalledWith({
        canvas_project_id: 'canvas-a',
        node_id: 'n1',
        version_id: 'v1',
        title: '节点结果',
        tags: [],
      }));
      expect(mocks.fromPath).not.toHaveBeenCalled();
    });

    it('previews by the given media kind rather than the URL', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [] });
      const { container } = render(
        <CreationAssetPanel
          saveRequest={{ requestId: 'r3', kind: 'media', title: '视频结果', previewUrl: '/api/canvas/projects/c/versions/v1/media?media_token=t', mediaKind: 'video', source: { kind: 'canvas_result', canvas_project_id: 'c', node_id: 'n1', version_id: 'v1' } }}
          onClose={vi.fn()}
          onUsePrompt={vi.fn()}
          onUseMedia={vi.fn()}
        />,
      );
      await screen.findByDisplayValue('视频结果');
      expect(container.querySelector('video')).toHaveAttribute('src', '/api/canvas/projects/c/versions/v1/media?media_token=t');
      expect(container.querySelector('img')).toBeNull();
    });

    it('falls back to the sourcePath suffix without its query string', async () => {
      mocks.list.mockResolvedValue({ revision: 1, assets: [] });
      const { container, rerender } = render(
        <CreationAssetPanel
          saveRequest={{ requestId: 'r4', kind: 'media', title: '片段', sourcePath: '/data/studio/clip.mp4?w=1&media_token=t' }}
          onClose={vi.fn()}
          onUsePrompt={vi.fn()}
          onUseMedia={vi.fn()}
        />,
      );
      await screen.findByDisplayValue('片段');
      expect(container.querySelector('video')).not.toBeNull();

      rerender(
        <CreationAssetPanel
          saveRequest={{ requestId: 'r5', kind: 'media', title: '预览', previewUrl: '/api/raw?path=clip.mp4&media_token=t' }}
          onClose={vi.fn()}
          onUsePrompt={vi.fn()}
          onUseMedia={vi.fn()}
        />,
      );
      await screen.findByDisplayValue('预览');
      expect(container.querySelector('video')).toBeNull();
      expect(screen.getByRole('img', { name: '媒体资产预览' })).toBeInTheDocument();
    });
  });

  it('passes the related sha256 through to the team panel', async () => {
    mocks.list.mockResolvedValue({ revision: 1, assets: [] });
    render(
      <CreationAssetPanel projectId="canvas-a" initialKind="team" teamRelatedSha256={'d'.repeat(64)} onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} onReproduce={vi.fn()} />,
    );
    expect(await screen.findByTestId('team-panel')).toHaveAttribute('data-related-sha256', 'd'.repeat(64));
  });
});
