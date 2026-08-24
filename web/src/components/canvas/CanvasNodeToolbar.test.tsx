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
  NodeResizer: () => null,
  NodeToolbar: ({ children, isVisible, ...props }: {
    children?: React.ReactNode;
    isVisible?: boolean;
  } & React.HTMLAttributes<HTMLDivElement>) => isVisible ? <div {...props}>{children}</div> : null,
  Handle: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Position: { Left: 'left', Right: 'right' },
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
  for (const node of nodes) {
    const toolbar = screen.getByRole('toolbar', { name: `${node.title} 节点工具` });
    expect(toolbar).toHaveAttribute('data-canvas-node-toolbar', node.id);
    expect(within(toolbar).getByRole('button', { name: `删除 ${node.title}` })).toBeInTheDocument();
  }

  const imageToolbar = screen.getByRole('toolbar', { name: '图片 节点工具' });
  fireEvent.click(within(imageToolbar).getByRole('button', { name: '上传到 图片' }));
  expect(context.replaceMedia).toHaveBeenCalledWith(nodes[1]);

  const firstTool = within(imageToolbar).getByRole('button', { name: '查看 图片 设置' });
  const secondTool = within(imageToolbar).getByRole('button', { name: '上传到 图片' });
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
    within(imageToolbar).getByRole('button', { name: '删除 图片' }),
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

  fireEvent.click(screen.getByRole('button', { name: '上传图片到 图片' }));
  fireEvent.click(screen.getByRole('button', { name: '上传视频到 视频' }));
  fireEvent.click(screen.getByRole('button', { name: '上传音频到 音频' }));
  expect(context.replaceMedia).toHaveBeenNthCalledWith(1, nodes[1]);
  expect(context.replaceMedia).toHaveBeenNthCalledWith(2, nodes[2]);
  expect(context.replaceMedia).toHaveBeenNthCalledWith(3, nodes[3]);
});

it('keeps populated media playable inside the node without opening preview from controls', async () => {
  const populated = nodes.slice(1, 4).map((node, index) => ({
    ...node,
    data: { ...node.data, current_version_id: `version-${node.type}` },
    ...(node.type === 'image'
      ? { data: { ...node.data, current_version_id: 'version-image', display: { fit: 'contain', free_resize: true } } }
      : node.type === 'video'
        ? { data: { ...node.data, current_version_id: 'version-video', display: { fit: 'cover', free_resize: false } } }
      : {}),
    id: `${node.id}-${index}`,
  })) as CanvasNode[];
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
  const video = container.querySelector('video[controls]');
  const audio = container.querySelector('audio[controls]');
  expect(video).toBeInTheDocument();
  expect(video).toHaveClass('object-cover');
  expect(audio).toBeInTheDocument();
  fireEvent.doubleClick(video!);
  fireEvent.doubleClick(audio!);
  expect(context.previewContent).not.toHaveBeenCalled();
});

it('keeps an unselected image toolbar mounted while its portal menu is open', async () => {
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

  const { container } = render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: image }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.pointerEnter(container.querySelector('.canvas-node-shell')!);
  const toolbar = screen.getByRole('toolbar', { name: '图片 节点工具' });
  const moreButton = within(toolbar).getByRole('button', { name: '更多 图片 图片工具' });
  act(() => moreButton.focus());
  fireEvent.keyDown(moreButton, { key: 'Enter' });
  expect(await screen.findByRole('menu')).toBeInTheDocument();

  fireEvent.pointerLeave(toolbar);
  await act(() => new Promise(resolve => window.setTimeout(resolve, 160)));

  expect(document.querySelector('[data-canvas-node-toolbar="image"]')).toBeInTheDocument();
  expect(screen.getByRole('menu')).toBeInTheDocument();
});
