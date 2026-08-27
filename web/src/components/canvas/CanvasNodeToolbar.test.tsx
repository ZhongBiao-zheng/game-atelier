import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import {
  CanvasNodeCard,
  CanvasNodeContext,
  type CanvasNodeContextValue,
} from './CanvasEditorViews';
import { DEFAULT_CANVAS_UI_PREFERENCES } from './canvasImageToolbar';
import type { CanvasNode } from '@/schema/canvas';

vi.mock('@xyflow/react', () => ({
  // 生成面板订阅 transform 重新定位；mock 返回常量数组，避免每次 render 换引用。
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
  NodeResizer: () => null,
  NodeToolbar: ({ children, isVisible, ...props }: {
    children?: React.ReactNode;
    isVisible?: boolean;
  } & React.HTMLAttributes<HTMLDivElement>) => isVisible ? <div {...props}>{children}</div> : null,
  Handle: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Position: { Left: 'left', Right: 'right', Top: 'top' },
}));

const draft = {
  mode: 'image' as const,
  prompt: '',
  input_policy: 'all_connected' as const,
  model: '',
  params: {},
  updated_at: '2026-08-25T00:00:00Z',
};

const nodes: CanvasNode[] = [
  {
    id: 'text', title: '文本', type: 'text', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: null, active_run_id: null,
      display: { scale: 'sm' },
    },
  },
  {
    id: 'image', title: '图片', type: 'image', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: null, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  },
  {
    id: 'video', title: '视频', type: 'video', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: null, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  },
  {
    id: 'audio', title: '音频', type: 'audio', position: { x: 0, y: 0 }, z_index: 0,
    data: { current_version_id: null, generation_draft: null, active_run_id: null },
  },
  {
    id: 'config', title: '配置', type: 'config', position: { x: 0, y: 0 }, z_index: 0,
    data: { draft },
  },
  {
    id: 'group', title: '分组', type: 'group', position: { x: 0, y: 0 }, z_index: 0,
    data: { member_node_ids: [] },
  },
  {
    id: 'plugin', title: '插件', type: 'plugin', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      plugin_id: 'test', node_type: 'test', plugin_version: '1',
      data_schema_version: 1, payload: {}, generation_draft: null,
    },
  },
];

function nodeContext(overrides: Partial<CanvasNodeContextValue> = {}): CanvasNodeContextValue {
  return {
    projectId: 'canvas-test',
    materialReferences: [],
    connectedMaterialNodeIdsByNodeId: new Map(),
    mentionReferencesByNodeId: new Map(),
    contentVersions: {},
    keys: [],
    jobsByRunId: new Map(),
    jobsByResultNodeId: new Map(),
    submittingNodeIds: new Set(),
    mediaReplaceBusyNodeIds: new Set(),
    mediaReplaceError: null,
    canvasUiPreferences: DEFAULT_CANVAS_UI_PREFERENCES,
    canvasUiPreferencesError: null,
    showImageInfo: false,
    libraryBusy: false,
    generationPanel: {
      dismissedNodeId: null,
      viewportZoom: 1,
      narrowViewport: false,
      dismiss: vi.fn(),
    },
    setMaterialConnected: vi.fn(),
    selectNode: vi.fn(),
    previewContent: vi.fn(),
    selectCandidate: vi.fn(),
    submitRun: vi.fn(async () => undefined),
    retryRun: vi.fn(async () => undefined),
    cancelRun: vi.fn(async () => undefined),
    dismissCandidate: vi.fn(async () => undefined),
    updateNode: vi.fn(),
    renameNode: vi.fn(),
    updateText: vi.fn(),
    createImageConfigFromText: vi.fn(),
    recordHistory: vi.fn(),
    saveAsset: vi.fn(async () => undefined),
    copyPrompt: vi.fn(async () => undefined),
    reversePrompt: vi.fn(async () => undefined),
    recoverReversePromptConfig: vi.fn(async () => undefined),
    reversePromptConfiguredNodeIds: new Set(),
    replaceMedia: vi.fn(),
    toggleFreeResize: vi.fn(),
    openMediaOperation: vi.fn(),
    openMaskEdit: vi.fn(),
    openAngle: vi.fn(),
    editVideo: vi.fn(),
    saveImageToolbarPreferences: vi.fn(async () => undefined),
    deleteNode: vi.fn(),
    ...overrides,
  };
}

const NodeCard = CanvasNodeCard as React.ComponentType<{
  data: { domain: CanvasNode };
  selected: boolean;
}>;

it('renders one independent selected toolbar for every canvas node type', () => {
  const context = nodeContext();
  render(
    <CanvasNodeContext.Provider value={context}>
      {nodes.map(node => <NodeCard key={node.id} data={{ domain: node }} selected />)}
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getAllByRole('toolbar')).toHaveLength(7);
  // 空媒体节点（image/video/audio）的工具条只保留一个上传入口，删除等动作要等它拿到内容版本。
  const emptyMediaTitles = new Set(['图片', '视频', '音频']);
  for (const node of nodes) {
    const toolbar = screen.getByRole('toolbar', { name: `${node.title} 节点工具` });
    expect(toolbar).toHaveAttribute('data-canvas-node-toolbar', node.id);
    if (emptyMediaTitles.has(node.title)) {
      expect(within(toolbar).getAllByRole('button').map(button => button.getAttribute('aria-label')))
        .toEqual([`上传${node.title}`]);
      continue;
    }
    expect(within(toolbar).getByRole('button', { name: `删除 ${node.title}` })).toBeInTheDocument();
  }

  const imageToolbar = screen.getByRole('toolbar', { name: '图片 节点工具' });
  fireEvent.click(within(imageToolbar).getByRole('button', { name: '上传图片' }));
  expect(context.replaceMedia).toHaveBeenCalledWith(nodes[1]);

  const configToolbar = screen.getByRole('toolbar', { name: '配置 节点工具' });
  const firstTool = within(configToolbar).getAllByRole('button')[0];
  const secondTool = within(configToolbar).getAllByRole('button')[1];
  expect(firstTool).toHaveAttribute('tabindex', '0');
  expect(secondTool).toHaveAttribute('tabindex', '-1');
  act(() => firstTool.focus());
  fireEvent.keyDown(firstTool, { key: 'ArrowRight' });
  expect(secondTool).toHaveFocus();
  expect(firstTool).toHaveAttribute('tabindex', '-1');
  expect(secondTool).toHaveAttribute('tabindex', '0');

  const imageShell = imageToolbar.closest('.canvas-node-shell');
  const title = within(imageShell as HTMLElement).getByRole('button', { name: '重命名节点 图片' });
  expect(title.closest('header')).not.toContainElement(
    within(imageToolbar).getByRole('button', { name: '上传图片' }),
  );
});

it('shows content actions in the floating toolbar instead of the title row', () => {
  const video = {
    ...nodes[2],
    data: { ...nodes[2].data, current_version_id: 'version-video' },
  } as CanvasNode;
  const context = nodeContext({
    contentVersions: {
      'version-video': {
        version_id: 'version-video',
        kind: 'video',
        created_at: '2026-08-25T00:00:00Z',
        sha256: 'a'.repeat(64),
        origin: { kind: 'upload', upload_id: 'upload-video' },
        path: 'uploads/upload-video.mp4',
        mime_type: 'video/mp4',
        bytes: 42,
        width: 1920,
        height: 1080,
        duration_ms: 1000,
      },
    },
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: video }} selected />
    </CanvasNodeContext.Provider>,
  );

  const toolbar = screen.getByRole('toolbar', { name: '视频 节点工具' });
  expect(within(toolbar).getByRole('button', { name: '查看 视频 详情' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '将 视频 存入资产库' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('link', { name: '下载 视频' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '替换 视频' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '编辑视频 视频' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重命名节点 视频' }).closest('header')).not.toContainElement(toolbar);
});

it('edits text inside the node as one history session', () => {
  const text = {
    ...nodes[0],
    data: { ...nodes[0].data, current_version_id: 'version-text' },
  } as CanvasNode;
  const context = nodeContext({
    contentVersions: {
      'version-text': {
        version_id: 'version-text',
        kind: 'text',
        text: '雨夜列车分镜',
        created_at: '2026-08-25T00:00:00Z',
        sha256: 'c'.repeat(64),
        origin: { kind: 'user_edit' },
      },
    },
  });

  const { container } = render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: text }} selected />
    </CanvasNodeContext.Provider>,
  );

  const toolbar = screen.getByRole('toolbar', { name: '文本 节点工具' });
  fireEvent.click(within(toolbar).getByRole('button', { name: '编辑文本 文本' }));

  const editor = screen.getByRole('textbox', { name: '编辑 文本 正文' });
  expect(editor).toHaveValue('雨夜列车分镜');
  expect(editor).toHaveFocus();
  expect(context.recordHistory).toHaveBeenCalledTimes(1);

  fireEvent.change(editor, { target: { value: '雨夜列车最终分镜' } });
  expect(context.updateText).toHaveBeenCalledWith('text', '雨夜列车最终分镜');
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: '编辑 文本 正文' })).not.toBeInTheDocument();

  fireEvent.doubleClick(container.querySelector('[data-canvas-node-id="text"]')!);
  expect(screen.getByRole('textbox', { name: '编辑 文本 正文' })).toBeInTheDocument();
  expect(context.recordHistory).toHaveBeenCalledTimes(2);
  expect(context.previewContent).not.toHaveBeenCalled();
});

it('cycles text size through Atelier type tokens', () => {
  const context = nodeContext();
  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: nodes[0] }} selected />
    </CanvasNodeContext.Provider>,
  );

  const toolbar = screen.getByRole('toolbar', { name: '文本 节点工具' });
  fireEvent.click(within(toolbar).getByRole('button', { name: '减小 文本 字号' }));
  const decrease = vi.mocked(context.updateNode).mock.calls[0]?.[1];
  expect(decrease?.(nodes[0])).toMatchObject({ data: { display: { scale: 'xs' } } });

  fireEvent.click(within(toolbar).getByRole('button', { name: '增大 文本 字号' }));
  const increase = vi.mocked(context.updateNode).mock.calls[1]?.[1];
  expect(increase?.(nodes[0])).toMatchObject({ data: { display: { scale: 'base' } } });
  expect(context.recordHistory).toHaveBeenCalledTimes(2);
});

it('creates an image config from populated text and disables the shortcut for empty text', () => {
  const populated = {
    ...nodes[0],
    data: { ...nodes[0].data, current_version_id: 'version-text' },
  } as CanvasNode;
  const context = nodeContext({
    contentVersions: {
      'version-text': {
        version_id: 'version-text', kind: 'text', text: '雨夜列车分镜',
        created_at: '2026-08-25T00:00:00Z', sha256: 'a'.repeat(64),
        origin: { kind: 'user_edit' },
      },
    },
  });
  const { rerender } = render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: populated }} selected />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '用 文本 生成图片' }));
  expect(context.createImageConfigFromText).toHaveBeenCalledWith('text');

  rerender(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: nodes[0] }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('button', { name: '用 文本 生成图片' })).toBeDisabled();
});

it('renders distinct empty media surfaces with direct upload actions', () => {
  const context = nodeContext();
  render(
    <CanvasNodeContext.Provider value={context}>
      {nodes.slice(1, 4).map(node => <NodeCard key={node.id} data={{ domain: node }} selected />)}
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByText('空图片节点')).toBeInTheDocument();
  expect(screen.getByText('空视频节点')).toBeInTheDocument();
  expect(screen.getByText('空音频节点')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '上传图片' }));
  fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
  fireEvent.click(screen.getByRole('button', { name: '上传音频' }));
  expect(context.replaceMedia).toHaveBeenNthCalledWith(1, nodes[1]);
  expect(context.replaceMedia).toHaveBeenNthCalledWith(2, nodes[2]);
  expect(context.replaceMedia).toHaveBeenNthCalledWith(3, nodes[3]);
});

it('keeps populated media playable inside the node without opening preview from controls', async () => {
  const populated = nodes.slice(1, 4).map((node, index) => {
    const data = { ...node.data, current_version_id: `version-${node.type}` };
    return {
      ...node,
      id: `${node.id}-${index}`,
      data: node.type === 'image'
        ? { ...data, display: { fit: 'contain', free_resize: true } }
        : node.type === 'video'
          ? { ...data, display: { fit: 'cover', free_resize: false } }
          : data,
    };
  }) as CanvasNode[];
  const context = nodeContext({
    contentVersions: {
      'version-image': {
        version_id: 'version-image', kind: 'image', path: 'uploads/image.png', mime_type: 'image/png', bytes: 42,
        width: 1024, height: 1024, duration_ms: null, created_at: '2026-08-25T00:00:00Z',
        sha256: 'd'.repeat(64), origin: { kind: 'upload', upload_id: 'image' },
      },
      'version-video': {
        version_id: 'version-video', kind: 'video', path: 'uploads/video.mp4', mime_type: 'video/mp4', bytes: 42,
        width: 1920, height: 1080, duration_ms: 1000, created_at: '2026-08-25T00:00:00Z',
        sha256: 'e'.repeat(64), origin: { kind: 'upload', upload_id: 'video' },
      },
      'version-audio': {
        version_id: 'version-audio', kind: 'audio', path: 'uploads/audio.mp3', mime_type: 'audio/mpeg', bytes: 42,
        width: null, height: null, duration_ms: 1000, created_at: '2026-08-25T00:00:00Z',
        sha256: 'f'.repeat(64), origin: { kind: 'upload', upload_id: 'audio' },
      },
    },
  });

  const { container } = render(
    <CanvasNodeContext.Provider value={context}>
      {populated.map(node => <NodeCard key={node.id} data={{ domain: node }} selected />)}
    </CanvasNodeContext.Provider>,
  );

  expect(container.querySelector('img.object-fill')).toBeInTheDocument();
  const video = container.querySelector<HTMLVideoElement>('video[data-canvas-media-controls="video"]');
  const audio = container.querySelector<HTMLAudioElement>('audio[controls]');
  expect(video).toBeInTheDocument();
  expect(video).toHaveClass('object-cover');
  expect(screen.getByRole('slider', { name: '视频播放进度' })).toBeInTheDocument();
  expect(screen.getByRole('slider', { name: '视频音量' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '静音 视频' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '全屏播放 视频' })).toBeInTheDocument();
  expect(audio).toBeInTheDocument();
  expect(fireEvent.click(video!, { clientY: 80 })).toBe(false);
  expect(context.selectNode).toHaveBeenCalledWith(populated[1].id);
  vi.mocked(context.selectNode).mockClear();

  const play = vi.spyOn(video!, 'play').mockResolvedValue();
  const pause = vi.spyOn(video!, 'pause').mockImplementation(() => undefined);
  const fullscreen = vi.fn(async () => undefined);
  Object.defineProperty(video!, 'requestFullscreen', { configurable: true, value: fullscreen });
  Object.defineProperty(video!, 'duration', { configurable: true, value: 100 });
  fireEvent.loadedMetadata(video!);
  fireEvent.change(screen.getByRole('slider', { name: '视频播放进度' }), { target: { value: '20' } });
  expect(video).toHaveProperty('currentTime', 20);
  fireEvent.change(screen.getByRole('slider', { name: '视频音量' }), { target: { value: '0.4' } });
  expect(video).toHaveProperty('volume', 0.4);
  fireEvent.click(screen.getByRole('button', { name: '静音 视频' }));
  expect(video).toHaveProperty('muted', true);
  fireEvent.click(screen.getByRole('button', { name: '全屏播放 视频' }));
  expect(fullscreen).toHaveBeenCalledOnce();
  expect(fireEvent.click(screen.getByRole('button', { name: '播放 视频' }))).toBe(true);
  expect(play).toHaveBeenCalledOnce();
  expect(context.selectNode).not.toHaveBeenCalled();
  fireEvent.play(video!);
  fireEvent.click(screen.getByRole('button', { name: '暂停 视频' }));
  expect(pause).toHaveBeenCalledOnce();
  expect(context.selectNode).not.toHaveBeenCalled();
  fireEvent.doubleClick(video!);
  fireEvent.doubleClick(audio!);
  expect(context.previewContent).not.toHaveBeenCalled();
});

it('shows every configured image action after selection and keeps it mounted while settings are open', async () => {
  const image = {
    ...nodes[1],
    data: { ...nodes[1].data, current_version_id: 'version-image' },
  } as CanvasNode;
  const context = nodeContext({
    contentVersions: {
      'version-image': {
        version_id: 'version-image',
        kind: 'image',
        created_at: '2026-08-25T00:00:00Z',
        sha256: 'b'.repeat(64),
        origin: { kind: 'upload', upload_id: 'upload-image' },
        path: 'uploads/upload-image.png',
        mime_type: 'image/png',
        bytes: 42,
        width: 1024,
        height: 1024,
        duration_ms: null,
      },
    },
  });

  const { rerender } = render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: image }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.pointerEnter(screen.getByRole('group', { name: '选择节点 图片，待编辑' }));
  expect(screen.queryByRole('toolbar', { name: '图片 节点工具' })).not.toBeInTheDocument();

  rerender(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: image }} selected />
    </CanvasNodeContext.Provider>,
  );

  const toolbar = screen.getByRole('toolbar', { name: '图片 节点工具' });
  expect(within(toolbar).getByRole('button', { name: '局部编辑 图片' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '裁剪 图片' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '切分 图片' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '本地放大 图片' })).toBeInTheDocument();
  const settingsButton = within(toolbar).getByRole('button', { name: '配置图片快捷工具' });
  act(() => settingsButton.focus());
  fireEvent.click(settingsButton);
  expect(await screen.findByRole('dialog', { name: '自定义图片快捷工具' })).toBeInTheDocument();

  rerender(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: image }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  expect(document.querySelector('[data-canvas-node-toolbar="image"]')).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: '自定义图片快捷工具' })).toBeInTheDocument();
});

it('treats an uploaded image as a pure material with toolbar and one direct replace action only', async () => {
  const uploadedImage = {
    ...nodes[1],
    data: {
      ...nodes[1].data,
      current_version_id: 'version-uploaded-image',
      generation_draft: draft,
    },
  } as CanvasNode;
  const context = nodeContext({
    contentVersions: {
      'version-uploaded-image': {
        version_id: 'version-uploaded-image',
        kind: 'image',
        created_at: '2026-08-25T00:00:00Z',
        sha256: 'c'.repeat(64),
        origin: { kind: 'upload', upload_id: 'upload-image' },
        path: 'uploads/upload-image.png',
        mime_type: 'image/png',
        bytes: 42,
        width: 1024,
        height: 1024,
        duration_ms: null,
      },
    },
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: uploadedImage }} selected />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByRole('toolbar', { name: '图片 节点工具' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '图片设置' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '替换图片 图片' }));
  expect(context.replaceMedia).toHaveBeenCalledWith(uploadedImage);

  const toolbar = screen.getByRole('toolbar', { name: '图片 节点工具' });
  expect(within(toolbar).queryByRole('button', { name: '替换 图片' })).not.toBeInTheDocument();
});
