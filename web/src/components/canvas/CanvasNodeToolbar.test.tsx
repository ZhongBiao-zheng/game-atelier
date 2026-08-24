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
    data: { current_version_id: null, generation_draft: null, active_run_id: null },
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
